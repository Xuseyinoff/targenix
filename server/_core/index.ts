import "dotenv/config";
import "../oauth/register";
import "../integrations";
import { validateEnv } from "./validateEnv";
validateEnv();
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerChatRoutes } from "./chat";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import facebookWebhookRouter from "../webhooks/facebookWebhook";
import { registerFacebookOAuthRoutes } from "../routes/facebookOAuthCallback";
import { registerFacebookLoginRoutes } from "../routes/facebookLoginOAuth";
import { registerOAuthRoutes } from "../routes/oauthRouter";
import { handleTelegramWebhook, registerTelegramWebhook } from "../webhooks/telegramWebhook";
import { log } from "../services/appLogger";
import { getLeadDispatchMode } from "../services/leadDispatch";
import { getDb } from "../db";
import { validateTemplatesAtBoot } from "../boot/validateTemplatesContract";
import type { Request, Response, NextFunction } from "express";

/**
 * HTTP request/response logging middleware.
 * Logs every API request with method, path, status, duration, IP, and a body preview.
 * Skips static assets and SSE streams to avoid noise.
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
    let bodyPreview: string | undefined;
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
      const REDACTED_KEYS = ["password", "currentPassword", "newPassword", "confirmNewPassword", "token", "secret", "accessToken"];
      const safe = Object.fromEntries(
        Object.entries(req.body as Record<string, unknown>).map(([k, v]) =>
          REDACTED_KEYS.includes(k) ? [k, "[REDACTED]"] : [k, v]
        ),
      );
      bodyPreview = JSON.stringify(safe).slice(0, 300);
    }

    void log[level.toLowerCase() as "info" | "warn" | "error"](
      "HTTP",
      `${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`,
      {
        method: req.method,
        path: req.path,
        query: Object.keys(req.query).length > 0 ? req.query : undefined,
        status: res.statusCode,
        duration,
        ip,
        ...(bodyPreview ? { bodyPreview } : {}),
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

async function startServer() {
  // Stage 1 — admin template contract check. Runs BEFORE express is
  // constructed so that a drifting DB/code pair aborts the deploy
  // instead of serving traffic with silently broken templates.
  const contractResult = await validateTemplatesAtBoot();
  console.log(
    `[Server] Template contract OK — validated=${contractResult.validatedTemplates} apps=${contractResult.knownApps}`,
  );

  const app = express();
  const server = createServer(app);

  // We're behind a proxy (Railway / reverse proxy) in production, so enable trust proxy
  // to let express-rate-limit and req.ip behave correctly with X-Forwarded-For.
  app.set("trust proxy", 1);

  // Security headers with Content Security Policy
  const analyticsHost = process.env.VITE_ANALYTICS_ENDPOINT
    ? new URL(process.env.VITE_ANALYTICS_ENDPOINT).origin
    : null;
  const forgeHost = process.env.VITE_FRONTEND_FORGE_API_URL
    ? new URL(process.env.VITE_FRONTEND_FORGE_API_URL).origin
    : "https://forge.butterfly-effect.dev";

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: [
            "'self'", "'unsafe-inline'",
            "https://connect.facebook.net",
            forgeHost,
            ...(analyticsHost ? [analyticsHost] : []),
          ],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: [
            "'self'",
            "https://graph.facebook.com", "https://*.facebook.com",
            forgeHost,
            ...(analyticsHost ? [analyticsHost] : []),
          ],
          frameSrc: ["https://www.facebook.com"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  // ── Rate Limiting (layered: specific → global, webhooks excluded from global) ──

  // Auth endpoints: 10 req per 15 min per IP (brute-force protection)
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many attempts. Please try again in 15 minutes." },
  });
  app.use("/api/trpc/auth.login", authLimiter);
  app.use("/api/trpc/auth.register", authLimiter);
  app.use("/api/trpc/auth.facebookLogin", authLimiter);
  app.use("/api/auth/facebook", authLimiter);

  // Password reset: 5 req per hour per IP (email spam prevention)
  const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many password reset requests. Please try again in 1 hour." },
  });
  app.use("/api/trpc/auth.forgotPassword", passwordResetLimiter);
  app.use("/api/trpc/auth.resetPassword", passwordResetLimiter);

  // Webhooks: 500 req per min per IP (Facebook sends bursts; HMAC protects integrity)
  const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many webhook requests." },
  });
  app.use("/api/webhooks", webhookLimiter);
  app.use("/api/telegram", webhookLimiter);

  // Global API: 200 req per min per IP (skip webhooks — they have their own limit)
  const globalApiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith("/api/webhooks") || req.path.startsWith("/api/telegram"),
    message: { error: "Too many requests. Please slow down." },
  });
  app.use("/api", globalApiLimiter);

  // Capture raw body for webhook signature verification BEFORE json parsing
  app.use((req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      (req as any).rawBody = Buffer.concat(chunks);
    });
    next();
  });

  // Body parser — 2 MB default, 10 MB for webhook payloads (Facebook can send large batches)
  app.use("/api/webhooks", express.json({ limit: "10mb" }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ limit: "2mb", extended: true }));

  // HTTP request/response logging (after body parsers so body is available)
  app.use(httpLogger);

  // Health check — used by Railway, Betterstack, and uptime monitors
  app.get("/api/health", async (_req, res) => {
    let dbOk = false;
    let lastWebhookAt: string | null = null;

    try {
      const db = await getDb();
      if (db) {
        const { webhookEvents } = await import("../../drizzle/schema");
        const { desc } = await import("drizzle-orm");
        const rows = await db
          .select({ createdAt: webhookEvents.createdAt })
          .from(webhookEvents)
          .orderBy(desc(webhookEvents.createdAt))
          .limit(1);
        dbOk = true;
        lastWebhookAt = rows[0]?.createdAt?.toISOString() ?? null;
      }
    } catch {
      dbOk = false;
    }

    const status = dbOk ? "ok" : "degraded";
    res.status(dbOk ? 200 : 503).json({
      status,
      dispatchMode: getLeadDispatchMode(),
      dbConnected: dbOk,
      lastWebhookAt,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Webhook routes (no auth required)
  app.use("/api/webhooks", facebookWebhookRouter);

  // Telegram bot webhook
  app.post("/api/telegram/webhook", (req, res) => {
    void handleTelegramWebhook(req, res);
  });

  // Facebook Authorization Code Flow OAuth routes
  registerFacebookOAuthRoutes(app);
  // Facebook Login/Register OAuth (separate from connection flow)
  registerFacebookLoginRoutes(app);
  // Google OAuth 2.0 (account connection — Sheets, Drive, etc.)
  registerOAuthRoutes(app);
  // Chat API disabled — no auth guard; re-enable with session check when needed
  // registerChatRoutes(app);
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

  const dispatchMode = getLeadDispatchMode();
  console.log(`[Server] Lead dispatch mode: ${dispatchMode}`);
  if (dispatchMode === "in-process") {
    console.warn("[Server] WARNING: REDIS_URL not set — leads processed in-process (not durable). Set REDIS_URL for production.");
  }

  // Register Telegram bot webhook URL with Telegram servers
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    void registerTelegramWebhook(appUrl);
  }

  // NOTE: Background schedulers (retry, log retention, forms refresh) are intentionally
  // NOT started here. They run exclusively in the worker process (server/workers/run.ts).
  // This prevents duplicate scheduler runs when the web server scales to multiple instances.
}

startServer().catch(console.error);
