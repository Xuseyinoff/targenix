import compression from "compression";
import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

// __dirname is only available in Node.js 21.2+.
// This polyfill works on Node.js 18+ and all ESM environments.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        __dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(__dirname, "../..", "dist", "public")
      : path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(compression());
  app.use(
    express.static(distPath, {
      maxAge: "1y",
      immutable: true,
      index: false,
    }),
  );

  // Fall through to index.html for SPA navigation routes.
  //
  // We must NOT serve index.html for missing hashed assets (e.g. an old
  // `Leads-3OV6HDIS.js` requested by a tab opened before the latest deploy).
  // Returning HTML with a 200 there makes the browser try to parse HTML as a
  // JS module and throw `Failed to fetch dynamically imported module`.
  // Letting that path 404 lets the client's `lazyWithRetry` recover by
  // reloading to pick up fresh chunk hashes.
  app.use("*", (req, res, next) => {
    const url = req.originalUrl.split("?")[0];
    if (url.startsWith("/assets/") || /\.[a-zA-Z0-9]+$/.test(url)) {
      return next();
    }
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
