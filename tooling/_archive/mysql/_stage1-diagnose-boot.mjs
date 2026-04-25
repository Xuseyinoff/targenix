/**
 * _stage1-diagnose-boot.mjs — diagnose exactly which active
 * destination_templates fail the Stage 1 contract in production.
 *
 * Runs the same rules as validateTemplatesAtBoot() but:
 *   • NEVER throws — prints every violation.
 *   • Also dumps bodyFields shape and appKey for every active row so
 *     we can eyeball malformed entries a human writer might have
 *     introduced.
 *   • Read-only. No writes.
 *
 * Usage (PowerShell):
 *   railway run -- node tooling/mysql/_stage1-diagnose-boot.mjs
 */

import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) {
  console.error("Need mysql:// URL via MYSQL_PUBLIC_URL / MYSQL_URL");
  process.exit(1);
}

// ─── In-process mirror of CONNECTION_APP_SPECS (read-only snapshot) ────────
// Keep in sync with server/integrations/connectionAppSpecs.ts. We duplicate
// here so this script is standalone and survives TS/require mismatches.
const SPECS = {
  alijahon: {
    sensitiveKeys: new Set(["api_key"]),
  },
  mgoods: {
    sensitiveKeys: new Set(["api_key"]),
  },
  sotuvchi: {
    sensitiveKeys: new Set(["api_key"]),
  },
  inbaza: {
    sensitiveKeys: new Set(["api_key"]),
  },
  "100k": {
    sensitiveKeys: new Set(["api_key"]),
  },
};

const SECRET_TOKEN_RE = /^\{\{\s*SECRET:([a-z][a-z0-9_]*)\s*\}\}$/;
const SECRET_TOKEN_GLOBAL_RE = /\{\{\s*SECRET:([a-z][a-z0-9_]*)\s*\}\}/g;
const LOOSE_SECRET_RE = /\{\{\s*SECRET\s*:\s*[^}]*\}\}/gi;

/**
 * Validate one template, returning an array of failure codes/messages
 * (empty on clean). Mirrors validateTemplateContract().
 */
function validateOne(row) {
  const failures = [];
  const appKey = row.appKey;
  if (typeof appKey !== "string" || appKey.length === 0) {
    failures.push({ code: "APP_KEY_MISSING", where: "row", detail: {} });
    return failures;
  }
  const spec = SPECS[appKey];
  if (!spec) {
    failures.push({
      code: "APP_KEY_UNKNOWN",
      where: "row",
      detail: { appKey },
    });
    return failures;
  }

  let bodyFields;
  try {
    bodyFields =
      typeof row.bodyFields === "string"
        ? JSON.parse(row.bodyFields)
        : row.bodyFields;
  } catch (e) {
    failures.push({
      code: "BODY_FIELDS_NOT_JSON",
      where: "row",
      detail: { parseError: e?.message ?? String(e) },
    });
    return failures;
  }

  if (!Array.isArray(bodyFields)) {
    failures.push({
      code: "BODY_FIELDS_NOT_ARRAY",
      where: "row",
      detail: { got: typeof bodyFields },
    });
    return failures;
  }

  bodyFields.forEach((f, index) => {
    const field = f && typeof f === "object" ? f : {};
    const key = typeof field.key === "string" ? field.key : "";
    const value = typeof field.value === "string" ? field.value : "";
    const isSecret = field.isSecret === true;

    if (isSecret) {
      const m = SECRET_TOKEN_RE.exec(value);
      if (!m) {
        failures.push({
          code: "SECRET_FIELD_NOT_TOKEN",
          where: `bodyFields[${index}]`,
          detail: { key, value },
        });
        return;
      }
      if (!spec.sensitiveKeys.has(m[1])) {
        failures.push({
          code: "SECRET_KEY_UNDECLARED",
          where: `bodyFields[${index}]`,
          detail: { key, secretKey: m[1] },
        });
      }
      return;
    }

    if (!value.includes("{{")) return;

    // Non-secret field but mentions SECRET: — still must resolve to a
    // declared sensitive key.
    const re = new RegExp(
      SECRET_TOKEN_GLOBAL_RE.source,
      SECRET_TOKEN_GLOBAL_RE.flags,
    );
    let match;
    while ((match = re.exec(value)) !== null) {
      if (!spec.sensitiveKeys.has(match[1])) {
        failures.push({
          code: "SECRET_KEY_UNDECLARED",
          where: `bodyFields[${index}]`,
          detail: { key, secretKey: match[1] },
        });
      }
    }

    // Malformed tokens (wrong casing / extra chars)
    const loose = new RegExp(LOOSE_SECRET_RE.source, LOOSE_SECRET_RE.flags);
    let loos;
    while ((loos = loose.exec(value)) !== null) {
      const canonical = new RegExp(
        SECRET_TOKEN_GLOBAL_RE.source,
        SECRET_TOKEN_GLOBAL_RE.flags,
      );
      if (!canonical.exec(loos[0])) {
        failures.push({
          code: "SECRET_TOKEN_MALFORMED",
          where: `bodyFields[${index}]`,
          detail: { key, token: loos[0] },
        });
      }
    }
  });

  return failures;
}

async function main() {
  const cn = await mysql.createConnection(url);
  try {
    console.log("─── Stage 1 boot-contract diagnostic ───");
    const [rows] = await cn.query(
      `SELECT id, name, appKey, isActive, endpointUrl, bodyFields
         FROM destination_templates
        ORDER BY id ASC`,
    );
    console.log(`Total rows:      ${rows.length}`);
    const active = rows.filter((r) => r.isActive === 1 || r.isActive === true);
    console.log(`Active rows:     ${active.length}`);
    console.log();

    const brokenRows = [];
    for (const r of rows) {
      const active = r.isActive === 1 || r.isActive === true;
      const failures = validateOne(r);
      const tag = active ? "A" : "-";
      const head = `[${tag}] id=${r.id}  appKey=${r.appKey ?? "∅"}  name="${r.name}"`;
      if (failures.length === 0) {
        console.log(`  ✓ ${head}`);
        continue;
      }
      if (active) brokenRows.push(r);
      console.log(`  ✗ ${head}`);
      for (const f of failures) {
        console.log(
          `      ${f.code} @ ${f.where}  ${JSON.stringify(f.detail)}`,
        );
      }
    }

    console.log();
    if (brokenRows.length === 0) {
      console.log("✓ All active templates are contract-clean.");
      process.exit(0);
    }

    console.log(
      `✗ ${brokenRows.length} active template(s) block the Stage 1 boot validator.`,
    );
    console.log();
    console.log("Full dump of every broken active row (for fix planning):");
    for (const r of brokenRows) {
      console.log(`\n── id=${r.id} name="${r.name}" appKey=${r.appKey ?? "∅"}`);
      console.log(`   endpoint: ${r.endpointUrl}`);
      console.log(`   bodyFields:`);
      let bf;
      try {
        bf =
          typeof r.bodyFields === "string"
            ? JSON.parse(r.bodyFields)
            : r.bodyFields;
      } catch {
        bf = r.bodyFields;
      }
      console.log(`   ${JSON.stringify(bf, null, 2)}`);
    }
    process.exit(2);
  } finally {
    await cn.end();
  }
}

main().catch((err) => {
  console.error("diagnostic failed:", err);
  process.exit(1);
});
