/**
 * Migrate ONE target_websites row from legacy (templateId NULL) to
 * admin template + api_key connection (ciphertext copied, no re-encrypt).
 * Agar kalit faqat `templateConfig.headers["X-API-KEY"]` da bo'lsa:
 *   avval `prep-legacy-apikey-header-to-secrets.mjs` ishga tushiring.
 *
 *   railway run --service targenix.uz node tooling/mysql/migrate-one-target-to-template-connection.mjs --dry-run --tw=60002 --template=4
 *   # Alijahon.uz (prod, user 1, tw=30003, shablon id=5):
 *   # railway run --service targenix.uz node ... --dry-run --tw=30003 --template=5
 *   # railway run --service targenix.uz node ... --apply --confirm=MIGRATE_ONE --tw=30003 --template=5
 *
 * Rollback: `rollback-migrate-one-connection.mjs` yoki chop etilgan `rollbackSql`
 */

import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

function parseArgs(argv) {
  const o = { dryRun: false, apply: false, tw: null, template: null, confirm: null };
  for (const a of argv) {
    if (a === "--dry-run") o.dryRun = true;
    if (a === "--apply") o.apply = true;
    if (a.startsWith("--tw=")) o.tw = parseInt(a.slice("--tw=".length), 10);
    if (a.startsWith("--template="))
      o.template = parseInt(a.slice("--template=".length), 10);
    if (a.startsWith("--confirm=")) o.confirm = a.slice("--confirm=".length);
  }
  return o;
}

function safeJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

function parseUserVisible(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args.dryRun && !args.apply) || (args.dryRun && args.apply)) {
    console.error("Pass exactly one of: --dry-run | --apply");
    process.exit(1);
  }
  if (!args.tw || !args.template) {
    console.error("Need --tw=<target_websites.id> --template=<destination_templates.id>");
    process.exit(1);
  }
  if (args.apply && args.confirm !== "MIGRATE_ONE") {
    console.error('Apply requires --confirm=MIGRATE_ONE');
    process.exit(1);
  }

  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL url");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [[tw]] = await conn.query(
      `SELECT id, userId, name, url, templateId, connectionId, templateConfig
         FROM target_websites WHERE id = ? LIMIT 1`,
      [args.tw],
    );
    if (!tw) {
      console.error("target_websites row not found");
      process.exit(1);
    }
    if (tw.templateId != null || tw.connectionId != null) {
      console.error(
        `Refuse: expected templateId and connectionId NULL, got templateId=${tw.templateId} connectionId=${tw.connectionId}`,
      );
      process.exit(1);
    }

    const [[tpl]] = await conn.query(
      `SELECT id, name, appKey, endpointUrl, userVisibleFields
         FROM destination_templates WHERE id = ? AND isActive = 1 LIMIT 1`,
      [args.template],
    );
    if (!tpl) {
      console.error("destination_templates not found or inactive");
      process.exit(1);
    }

    const expectedKeys = parseUserVisible(tpl.userVisibleFields);
    const cfg = safeJson(tw.templateConfig) ?? {};
    const secrets = cfg.secrets;
    if (!secrets || typeof secrets !== "object") {
      console.error("No templateConfig.secrets on target row");
      process.exit(1);
    }

    for (const k of expectedKeys) {
      if (typeof secrets[k] !== "string" || !secrets[k].length) {
        console.error(`Missing or empty secret key in templateConfig: ${k}`);
        process.exit(1);
      }
    }
    const extra = Object.keys(secrets).filter((k) => !expectedKeys.includes(k));
    if (extra.length) {
      console.error(`Extra secret keys not in template userVisibleFields: ${extra.join(",")}`);
      process.exit(1);
    }

    const secretsEncrypted = {};
    for (const k of expectedKeys) {
      secretsEncrypted[k] = secrets[k];
    }

    const twUrl = (tw.url || "").trim();
    const ep = (tpl.endpointUrl || "").trim();
    const urlMatch = twUrl === ep;

    const displayName = `${tpl.name} (migrate tw=${tw.id})`;
    const appKey = tpl.appKey || null;

    const plan = {
      targetWebsiteId: tw.id,
      userId: tw.userId,
      templateId: tpl.id,
      templateName: tpl.name,
      appKey,
      displayName,
      endpointUrl: ep,
      targetUrl: twUrl,
      urlMatch,
      secretsKeys: expectedKeys,
    };

    if (args.dryRun) {
      console.log("[migrate-one] DRY-RUN — no writes\n" + JSON.stringify(plan, null, 2));
      process.exit(0);
    }

    const credsJson = JSON.stringify({
      templateId: tpl.id,
      secretsEncrypted,
    });

    const [ins] = await conn.query(
      `INSERT INTO connections
        (userId, type, appKey, displayName, status, credentialsJson, lastVerifiedAt, createdAt, updatedAt)
       VALUES (?, 'api_key', ?, ?, 'active', ?, NOW(), NOW(), NOW())`,
      [tw.userId, appKey, displayName, credsJson],
    );
    const newConnId = ins.insertId;

    const [upd] = await conn.query(
      `UPDATE target_websites
          SET templateId = ?, connectionId = ?, templateType = 'custom'
        WHERE id = ? AND userId = ? AND connectionId IS NULL AND templateId IS NULL`,
      [tpl.id, newConnId, tw.id, tw.userId],
    );
    if (upd.affectedRows !== 1) {
      console.error(
        "UPDATE affected 0 rows — rolling back new connection insert if possible",
      );
      await conn.query(`DELETE FROM connections WHERE id = ?`, [newConnId]);
      process.exit(1);
    }

    console.log(
      "[migrate-one] APPLY OK\n" +
        JSON.stringify(
          {
            ...plan,
            newConnectionId: newConnId,
            rollbackSql: `-- ROLLBACK:\nUPDATE target_websites SET templateId = NULL, connectionId = NULL WHERE id = ${tw.id};\nDELETE FROM connections WHERE id = ${newConnId};`,
          },
          null,
          2,
        ),
    );
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
