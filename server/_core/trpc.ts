import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { log } from "../services/appLogger";
import { getDb } from "../db";
import { recordAdminAction } from "../services/adminAuditService";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * tRPC logging middleware — wraps every procedure call and writes a structured
 * log entry with the procedure path, calling user, duration, and any error.
 */
const trpcLogger = t.middleware(async (opts) => {
  const { path, type, ctx, next } = opts;
  const startAt = Date.now();
  const userId = (ctx as TrpcContext).user?.id ?? null;

  // Skip logging for logs.* procedures to avoid recursive DB writes
  const isLogsPath = path.startsWith("logs.");

  try {
    const result = await next();
    const duration = Date.now() - startAt;

    // Only log mutations and slow queries (>200ms) to reduce noise; never log logs.* paths
    if (!isLogsPath && (type === "mutation" || duration > 200)) {
      void log.info(
        "SYSTEM",
        `tRPC ${type} ${path} → OK (${duration}ms)`,
        { path, type, userId, duration }
      );
    }

    return result;
  } catch (err) {
    const duration = Date.now() - startAt;
    const isTrpcError = err instanceof TRPCError;
    const code = isTrpcError ? err.code : "INTERNAL_SERVER_ERROR";
    const message = err instanceof Error ? err.message : String(err);

    // Don't log UNAUTHORIZED as an error — it's expected for unauthenticated users
    // Also skip error logging for logs.* paths to avoid recursive DB writes
    const level = code === "UNAUTHORIZED" || code === "FORBIDDEN" ? "warn" : "error";

    if (!isLogsPath) {
      void log[level](
        "SYSTEM",
        `tRPC ${type} ${path} → ${code} (${duration}ms): ${message}`,
        { path, type, userId, duration, code, error: message }
      );
    }

    throw err;
  }
});

export const publicProcedure = t.procedure.use(trpcLogger);

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

/**
 * Forensic audit middleware — wraps every admin-protected mutation with a
 * row in `admin_audit_log` capturing (adminId, path, sanitized input,
 * outcome, duration, ip, user-agent). Roadmap #12.
 *
 * Mutations are recorded always; queries are skipped because they're high-
 * volume and rarely interesting for "who changed what". A future opt-in
 * read-audit could record specific sensitive queries (e.g. exporting all
 * user emails); the table schema already supports `type = "query"`.
 *
 * Failures are best-effort: a broken audit subsystem must not break admin
 * functionality. The audit service itself catches its own DB errors.
 *
 * Also exported as `adminAuditProcedureMiddleware` so the temp-access
 * `templateEditorProcedure` in adminTemplatesRouter can opt in without
 * importing internals. The widened actor surface — admin-equivalent
 * writes from a non-admin user — makes auditing MORE important there.
 */
const adminAuditMiddleware = t.middleware(async (opts) => {
  const { ctx, next, path, type, getRawInput } = opts;
  const start = Date.now();
  const adminId = (ctx as TrpcContext).user?.id ?? null;

  // Only mutations get audited today. Queries are too noisy and the cost
  // of one extra DB write per query would dominate read latency.
  const shouldAudit = type === "mutation" && adminId != null;

  let rawInput: unknown = undefined;
  if (shouldAudit) {
    try {
      rawInput = await getRawInput();
    } catch {
      // If we can't read the input (e.g. parse error before middleware runs),
      // leave it null — the audit row is still useful for path+adminId+outcome.
      rawInput = undefined;
    }
  }

  try {
    const result = await next();
    if (shouldAudit) {
      const durationMs = Date.now() - start;
      void writeAuditRow({
        adminId: adminId!,
        path,
        type,
        rawInput,
        outcome: { status: "success" },
        durationMs,
        ctx: ctx as TrpcContext,
      });
    }
    return result;
  } catch (err) {
    if (shouldAudit) {
      const durationMs = Date.now() - start;
      const isTrpc = err instanceof TRPCError;
      void writeAuditRow({
        adminId: adminId!,
        path,
        type,
        rawInput,
        outcome: {
          status: "failure",
          errorCode: isTrpc ? err.code : "INTERNAL_SERVER_ERROR",
          errorMessage: err instanceof Error ? err.message : String(err),
        },
        durationMs,
        ctx: ctx as TrpcContext,
      });
    }
    throw err;
  }
});

interface AuditWriteParams {
  adminId: number;
  path: string;
  type: "mutation" | "query";
  rawInput: unknown;
  outcome:
    | { status: "success" }
    | { status: "failure"; errorCode: string; errorMessage: string };
  durationMs: number;
  ctx: TrpcContext;
}

async function writeAuditRow(p: AuditWriteParams): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return; // DB not yet initialized — drop silently, app log already warned

    const reqIp = (p.ctx.req?.ip ?? null) || null;
    const reqUa = p.ctx.req?.headers?.["user-agent"] ?? null;
    const userAgent = typeof reqUa === "string" ? reqUa : Array.isArray(reqUa) ? reqUa[0] : null;

    await recordAdminAction(db, {
      adminId: p.adminId,
      path: p.path,
      type: p.type,
      input: p.rawInput,
      resultStatus: p.outcome.status,
      errorCode: p.outcome.status === "failure" ? p.outcome.errorCode : null,
      errorMessage: p.outcome.status === "failure" ? p.outcome.errorMessage : null,
      durationMs: p.durationMs,
      ipAddress: reqIp,
      userAgent,
    });
  } catch (err) {
    void log.error(
      "SYSTEM",
      "admin audit middleware threw outside recordAdminAction",
      { path: p.path, error: err instanceof Error ? err.message : String(err) },
      null,
      null,
      p.adminId,
    );
  }
}

export const adminAuditProcedureMiddleware = adminAuditMiddleware;

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
).use(adminAuditMiddleware);
