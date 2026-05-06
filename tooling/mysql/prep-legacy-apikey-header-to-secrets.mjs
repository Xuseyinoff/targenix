/**
 * Legacy target: API kalit `templateConfig.headers["X-API-KEY"]` da bo'lsa,
 * uni `templateConfig.secrets.api_key` ga (encrypt) ko'chiradi — keyin
 * migrate-one-target-to-template-connection ishlay oladi.
 *
 *   railway run --service targenix.uz node ... --dry-run --tw=60005
 *   railway run --service targenix.uz node ... --apply --confirm=PREP --tw=60005
 */

import "dotenv/config";
import { createCipheriv, createHash, randomBytes } from "crypto";
import mysql from "mysql2/promise";

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY kerak");
  return createHash("sha256").update(raw).digest();
}

function encrypt(plaintext) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

function parseArgs(argv) {
  const o = { dryRun: false, apply: false, tw: null, confirm: null };
  for (const a of argv) {
    if (a === "--dry-run") o.dryRun = true;
    if (a === "--apply") o.apply = true;
    if (a.startsWith("--tw=")) o.tw = parseInt(a.slice(5), 10);
    if (a.startsWith("--confirm=")) o.confirm = a.slice(10);
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args.dryRun && !args.apply) || (args.dryRun && args.apply)) {
    console.error("--dry-run yoki --apply");
    process.exit(1);
  }
  if (!args.tw) {
    console.error("--tw=...");
    process.exit(1);
  }
  if (args.apply && args.confirm !== "PREP") {
    console.error("--confirm=PREP");
    process.exit(1);
  }

  const url =
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL;
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [[tw]] = await conn.query(
      `SELECT id, userId, templateConfig, templateId, connectionId FROM target_websites WHERE id = ?`,
      [args.tw],
    );
    if (!tw) {
      console.error("topilmadi");
      process.exit(1);
    }
    if (tw.templateId != null || tw.connectionId != null) {
      console.error(
        `Refuse: templateId=${tw.templateId} connectionId=${tw.connectionId}`,
      );
      process.exit(1);
    }

    let cfg =
      typeof tw.templateConfig === "string"
        ? JSON.parse(tw.templateConfig)
        : tw.templateConfig;
    cfg = cfg && typeof cfg === "object" ? { ...cfg } : {};

    const headers = cfg.headers && typeof cfg.headers === "object" ? { ...cfg.headers } : {};
    const rawKey =
      headers["X-API-KEY"] ||
      headers["x-api-key"] ||
      headers["X-Api-Key"];
    if (typeof rawKey !== "string" || !rawKey.length) {
      console.error("headers da X-API-KEY yo'q yoki bo'sh");
      process.exit(1);
    }

    if (
      cfg.secrets &&
      typeof cfg.secrets === "object" &&
      cfg.secrets.api_key
    ) {
      console.error("allaqachon templateConfig.secrets.api_key bor");
      process.exit(1);
    }

    const enc = encrypt(rawKey);
    const newCfg = { ...cfg };
    newCfg.secrets = { ...(cfg.secrets || {}), api_key: enc };
    if (Object.keys(headers).length) {
      const h2 = { ...headers };
      delete h2["X-API-KEY"];
      delete h2["x-api-key"];
      delete h2["X-Api-Key"];
      newCfg.headers = h2;
      if (Object.keys(h2).length === 0) newCfg.headers = {};
    }
    if (Object.keys(newCfg.headers || {}).length === 0) {
      newCfg.headers = {};
    }

    const plan = {
      tw: args.tw,
      willRemovePlainHeader: true,
      willAddSecretsApiKey: true,
    };
    if (args.dryRun) {
      console.log(
        JSON.stringify({ mode: "dry-run", plan, previewHeaders: newCfg.headers }, null, 2),
      );
      process.exit(0);
    }

    await conn.query(`UPDATE target_websites SET templateConfig = ? WHERE id = ? AND userId = ?`, [
      JSON.stringify(newCfg),
      tw.id,
      tw.userId,
    ]);
    console.log(
      JSON.stringify(
        { ok: true, ...plan, next: "migrate-one --tw=" + args.tw + " --template=1" },
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
