import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import helmet from "helmet";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerChatRoutes } from "./chat";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import facebookWebhookRouter from "../webhooks/facebookWebhook";
import { handleTelegramWebhook, registerTelegramWebhook } from "../webhooks/telegramWebhook";
import { log } from "../services/appLogger";
import { startRetryScheduler } from "../services/retryScheduler";
import { startLogRetentionScheduler } from "../services/logRetentionScheduler";
import { startFormsRefreshScheduler } from "../services/formsRefreshScheduler";
import { getLeadDispatchMode } from "../services/leadDispatch";
import { startLeadWorker } from "../workers/leadWorker";
import { summarizeRequestPayload } from "./httpLogging";
import type { Request, Response, NextFunction } from "express";

/**
 * HTTP request/response logging middleware.
 * Logs every API request with method, path, status, duration, IP, and redacted
 * request shape metadata. Skips static assets and SSE streams to avoid noise.
 */
function httpLogger(req: Request, res: Response, next: NextFunction): void {
  // Skip static assets, Vite HMR, SSE streams, and logs.* tRPC calls (avoid recursive DB writes)
  const skip =
    req.path.startsWith("/@") ||
    req.path.startsWith("/node_modules") ||
    req.path.startsWith("/src") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".ts") ||
    req.path.endsWith(".css") ||
    req.path.endsWith(".map") ||
    req.path.endsWith(".ico") ||
    req.path.endsWith(".png") ||
    req.path.endsWith(".svg") ||
    req.path.includes("/events/stream") ||
    // Suppress logs page polling to avoid recursive writes
    (req.path.startsWith("/api/trpc/") && req.path.includes("logs."));

  if (skip) { next(); return; }

  const startAt = Date.now();
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";

  res.on("finish", () => {
    const duration = Date.now() - startAt;
    const level = res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO";
    const querySummary = summarizeRequestPayload(req.query);
    const bodySummary = summarizeRequestPayload(req.body);

    void log[level.toLowerCase() as "info" | "warn" | "error"](
      "HTTP",
      `${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
      {
        method: req.method,
        path: req.path,
        ...(querySummary ? { querySummary } : {}),
        status: res.statusCode,
        duration,
        ip,
        ...(bodySummary ? { bodySummary } : {}),
      }
    );
  });

  next();
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
  skip: (req) =>
    req.path.startsWith("/@") ||
    req.path.startsWith("/node_modules") ||
    req.path.startsWith("/src") ||
    req.path.endsWith(".js") ||
    req.path.endsWith(".ts") ||
    req.path.endsWith(".css"),
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts, please try again in 15 minutes." },
});

const INSECURE_DEFAULTS = new Set([
  "jwt_secret_for_dev",
  "12345678901234567890123456789012",
  "facebook_secret",
  "verify_token",
  "owner_open_id",
]);

function validateSecrets() {
  if (process.env.NODE_ENV !== "production") return;

  const checks: Array<[string, string | undefined]> = [
    ["JWT_SECRET", process.env.JWT_SECRET],
    ["ENCRYPTION_KEY", process.env.ENCRYPTION_KEY],
    ["FACEBOOK_APP_SECRET", process.env.FACEBOOK_APP_SECRET],
    ["FACEBOOK_VERIFY_TOKEN", process.env.FACEBOOK_VERIFY_TOKEN],
    ["OWNER_OPEN_ID", process.env.OWNER_OPEN_ID],
  ];

  const issues: string[] = [];

  for (const [name, value] of checks) {
    if (!value || value.trim() === "") {
      issues.push(`  • ${name} is not set`);
    } else if (INSECURE_DEFAULTS.has(value.trim())) {
      issues.push(`  • ${name} is using an insecure default value`);
    }
  }

  if (process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length !== 32) {
    issues.push(`  • ENCRYPTION_KEY must be exactly 32 characters (got ${process.env.ENCRYPTION_KEY.length})`);
  }

  if (issues.length > 0) {
    console.error("\n[Security] FATAL: Insecure configuration detected in production:\n" + issues.join("\n"));
    console.error("[Security] Fix the above issues before running in production.\n");
    process.exit(1);
  }
}

async function startServer() {
  validateSecrets();

  const app = express();
  const server = createServer(app);

  // Security headers
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS — only allow requests from APP_URL in production
  const allowedOrigin = process.env.APP_URL || "http://localhost:3000";
  app.use(
    cors({
      origin: allowedOrigin,
      credentials: true,
    })
  );

  // Global rate limiting
  app.use(globalLimiter);

  // Stricter rate limit for auth endpoints
  app.use("/api/trpc/emailAuth.", authLimiter);
  app.use("/api/oauth", authLimiter);

  // Capture raw body for webhook signature verification BEFORE json parsing
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      (req as any).rawBody = Buffer.concat(chunks);
    });
    next();
  });

  // Configure body parser with larger size limit
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // HTTP request/response logging (after body parsers so body is available)
  app.use(httpLogger);

  // Webhook routes (no auth required)
  app.use("/api/webhooks", facebookWebhookRouter);

  // Telegram bot webhook
  app.post("/api/telegram/webhook", (req, res) => {
    void handleTelegramWebhook(req, res);
  });

  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // Chat API with streaming and tool calling
  registerChatRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // Development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });

  const leadDispatchMode = getLeadDispatchMode();
  console.log(`[Server] Lead processing mode: ${leadDispatchMode}`);

  if (leadDispatchMode === "queue") {
    startLeadWorker();
  }

  // Register Telegram bot webhook URL with Telegram servers
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    void registerTelegramWebhook(appUrl);
  }

  // Start hourly auto-retry scheduler for FAILED leads
  startRetryScheduler();

  // Start hourly log retention cleanup (48h for users, 30d for admins)
  startLogRetentionScheduler();

  // Start 24h forms refresh scheduler (keeps facebook_forms table up to date)
  startFormsRefreshScheduler();
}

startServer().catch(console.error);
