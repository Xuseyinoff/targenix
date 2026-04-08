import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { log } from "../services/appLogger";

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
);
