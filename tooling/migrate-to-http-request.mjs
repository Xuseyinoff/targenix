/**
 * Phase 3 of the http-refactor — migrate destinations off
 * `webhook-json` / `plain-url` / `crm-generic` onto the universal
 * `http-request` app.
 *
 * Production audit at write time: 0 active destinations use any of the
 * three legacy appKeys (see tooling/audit-http-destinations.mjs). This
 * script is defensive — it covers the case where one appears later (e.g.
 * a staging test row, a backfill from a tooling experiment) so the
 * Phase 4 cleanup can run without leaving stranded data.
 *
 * Translation rules:
 *
 *   webhook-json (auth=none, fixed JSON):
 *     {
 *       url:          <templateConfig.endpointUrl>,
 *       method:       "POST",
 *       authentication: { scheme: "none" },
 *       bodyGroup: {
 *         contentType:  "json",
 *         bodyTemplate: serialiseLegacyBody(name, phone, email, source),
 *       },
 *     }
 *
 *   plain-url (auth=none, full flexibility):
 *     {
 *       url:          <templateConfig.url ?? destinations.url>,
 *       method:       <templateConfig.method ?? "POST">,
 *       authentication: { scheme: "none" },
 *       bodyGroup: {
 *         contentType:  <templateConfig.contentType ?? "json">,
 *         bodyTemplate: <templateConfig.bodyTemplate>,
 *         bodyFields:   <templateConfig.bodyFields>,
 *       },
 *       advanced: {
 *         headers:     <templateConfig.headers as Array<{name,value}>>,
 *         queryParams: <(none — plain-url merged into URL at create)>,
 *       },
 *     }
 *
 *   crm-generic (auth=bearer, JSON body):
 *     SKIPPED in this pass — bearer token lives in
 *     `connections.credentialsJson.apiKeyEncrypted` (encrypted at rest).
 *     The universal manifest stores the token in plain templateConfig,
 *     which would regress encryption-at-rest. A follow-up commit adds
 *     `httpRequestAdapter` support for encrypted secrets + a connection
 *     fallback before crm-generic migration is safe.
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/migrate-to-http-request.mjs
 *   railway run --service targenix.uz node tooling/migrate-to-http-request.mjs --apply
 *
 * Default mode is DRY-RUN. Idempotent — re-running after a partial apply
 * only picks up the rows that still have the legacy appKey.
 */
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("No mysql:// URL in env");
  process.exit(1);
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

function fromWebhookJson(d, cfg) {
  const url = (cfg?.endpointUrl ?? "").toString().trim();
  if (!url) {
    return { skip: true, reason: "webhook-json row has no endpointUrl in templateConfig" };
  }
  const lines = [];
  lines.push("{");
  const pairs = [];
  for (const key of ["name", "phone", "email", "source"]) {
    if (cfg?.[key] != null && cfg[key] !== "") {
      pairs.push(`  "${key}": "${String(cfg[key]).replace(/"/g, '\\"')}"`);
    }
  }
  // Always include the four canonical fields even when blank so the
  // migrated destination behaves identically to the legacy adapter.
  if (pairs.length === 0) {
    pairs.push(
      '  "name": "{{full_name}}"',
      '  "phone": "{{phone_number}}"',
      '  "email": "{{email}}"',
      '  "source": "targenix"',
    );
  }
  lines.push(pairs.join(",\n"));
  lines.push("}");
  return {
    skip: false,
    nextConfig: {
      url,
      method: "POST",
      authentication: { scheme: "none" },
      bodyGroup: { contentType: "json", bodyTemplate: lines.join("\n") },
    },
  };
}

function fromPlainUrl(d, cfg) {
  const url = (cfg?.url ?? d.url ?? "").toString().trim();
  if (!url) {
    return { skip: true, reason: "plain-url row has no url in templateConfig or destinations.url" };
  }
  const method = (cfg?.method ?? "POST").toString().toUpperCase();
  const contentTypeRaw = (cfg?.contentType ?? "json").toString();
  const contentType =
    contentTypeRaw === "form-urlencoded" || contentTypeRaw === "multipart"
      ? contentTypeRaw
      : "json";

  // headers stored as Record<string,string> on plain-url; convert to the
  // repeatable {name,value} shape the new manifest uses.
  const headersArr = [];
  if (cfg?.headers && typeof cfg.headers === "object" && !Array.isArray(cfg.headers)) {
    for (const [name, value] of Object.entries(cfg.headers)) {
      if (typeof value === "string") headersArr.push({ name, value });
    }
  }

  const bodyGroup = { contentType };
  if (contentType === "json" && typeof cfg?.bodyTemplate === "string") {
    bodyGroup.bodyTemplate = cfg.bodyTemplate;
  }
  if ((contentType === "form-urlencoded" || contentType === "multipart") && Array.isArray(cfg?.bodyFields)) {
    bodyGroup.bodyFields = cfg.bodyFields;
  }

  return {
    skip: false,
    nextConfig: {
      url,
      method,
      authentication: { scheme: "none" },
      bodyGroup,
      ...(headersArr.length > 0 ? { advanced: { headers: headersArr } } : {}),
    },
  };
}

const TRANSFORMS = {
  "webhook-json": fromWebhookJson,
  "plain-url": fromPlainUrl,
  // crm-generic intentionally absent — see header comment.
};

const conn = await mysql.createConnection(url);
try {
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  const [rows] = await conn.query(
    `SELECT id, name, appKey, url, connectionId, templateConfig
     FROM destinations
     WHERE appKey IN ('webhook-json', 'plain-url', 'crm-generic')
       AND isActive = 1
     ORDER BY id ASC`,
  );

  const stats = { migrate: 0, skip: 0, crmDeferred: 0, errors: 0 };
  const planned = [];

  for (const d of rows) {
    if (d.appKey === "crm-generic") {
      stats.crmDeferred++;
      console.log(`  [DEFER] id=${d.id} name="${d.name}" appKey=crm-generic — Bearer secrets live on connection; needs Phase 4a (encrypted templateConfig)`);
      continue;
    }
    const transform = TRANSFORMS[d.appKey];
    if (!transform) {
      stats.errors++;
      continue;
    }
    const cfg = parseJson(d.templateConfig) ?? {};
    const out = transform(d, cfg);
    if (out.skip) {
      stats.skip++;
      console.log(`  [SKIP ] id=${d.id} name="${d.name}" — ${out.reason}`);
      continue;
    }
    stats.migrate++;
    planned.push({ id: d.id, name: d.name, from: d.appKey, nextConfig: out.nextConfig });
    console.log(`  [PLAN ] id=${d.id} name="${d.name}" ${d.appKey} → http-request`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`  total active rows in legacy appKeys: ${rows.length}`);
  console.log(`  will migrate:        ${stats.migrate}`);
  console.log(`  skipped (no url):    ${stats.skip}`);
  console.log(`  deferred (crm-generic, bearer secret): ${stats.crmDeferred}`);
  console.log(`  unknown appKey:      ${stats.errors}`);

  if (!APPLY) {
    console.log("\nDRY-RUN done. Re-run with --apply to migrate the planned rows.");
    process.exit(0);
  }

  if (planned.length === 0) {
    console.log("\nNothing to apply.");
    process.exit(0);
  }

  await conn.beginTransaction();
  try {
    for (const p of planned) {
      await conn.query(
        `UPDATE destinations
         SET appKey = 'http-request',
             url = NULL,
             templateConfig = ?
         WHERE id = ? AND appKey = ?`,
        [JSON.stringify(p.nextConfig), p.id, p.from],
      );
    }
    await conn.commit();
    console.log(`\nApplied ${planned.length} migrations.`);
  } catch (e) {
    await conn.rollback();
    throw e;
  }

  console.log(`\n=== Post-state ===`);
  const [after] = await conn.query(
    `SELECT appKey, COUNT(*) AS n FROM destinations
     WHERE appKey IN ('webhook-json', 'plain-url', 'crm-generic', 'http-request')
       AND isActive = 1
     GROUP BY appKey`,
  );
  for (const r of after) {
    console.log(`  ${r.appKey.padEnd(16)} active=${r.n}`);
  }
} finally {
  await conn.end();
}
