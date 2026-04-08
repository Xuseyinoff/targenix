import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerChatRoutes } from "./chat";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import facebookWebhookRouter from "../webhooks/facebookWebhook";
import { registerFacebookOAuthRoutes } from "../routes/facebookOAuthCallback";
import { handleTelegramWebhook, registerTelegramWebhook } from "../webhooks/telegramWebhook";
import { log } from "../services/appLogger";
import { startRetryScheduler } from "../services/retryScheduler";
import { startLogRetentionScheduler } from "../services/logRetentionScheduler";
import { startFormsRefreshScheduler } from "../services/formsRefreshScheduler";
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
    const bodyPreview =
      req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
        ? JSON.stringify(req.body).slice(0, 300)
        : undefined;

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
  const app = express();
  const server = createServer(app);

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
  // Facebook Authorization Code Flow OAuth routes
  registerFacebookOAuthRoutes(app);
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

  console.log("[Server] Lead processing: synchronous in-process mode (no Redis required)");

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
