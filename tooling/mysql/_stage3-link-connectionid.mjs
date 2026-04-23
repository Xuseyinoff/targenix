/**
 * Stage 3 Phase 3 — SAFE CONNECTION LINK BACKFILL for legacy destinations.
 *
 * Goal:
 *   Populate `target_websites.connectionId` on rows that still read
 *   credentials from `templateConfig.secrets` (the pre-Stage-2 store),
 *   so Phase 4 can flip `USE_CONNECTION_SECRETS_ONLY=true` without
 *   orphaning anything.
 *
 * Absolute invariants — re-stated from the Stage 3 spec:
 *   • DO NOT delete or overwrite ANY field (not even empty map keys).
 *   • DO NOT touch `templateConfig.secrets` in any way — reads only.
 *   • NEVER link when the match is not provably safe.
 *   • The migration is idempotent: running it twice is a no-op on the
 *     second pass (rows with `connectionId IS NOT NULL` are skipped
 *     entirely).
 *
 * Match rule (both must hold):
 *   1. Exactly ONE active connection exists for
 *      (target_website.userId, destination_template.appKey).
 *   2. Every secret stored on the destination decrypts to the same
 *      plaintext as the same-named secret stored on the connection.
 *
 * Why both conditions? Condition 1 alone is too permissive: if a user
 * rotated their api_key on the connection but the destination still
 * carries the old ciphertext, linking would silently swap credentials
 * at delivery time. Condition 2 guards against that — we only "bless"
 * the link when both stores already agree.
 *
 * When a row cannot be linked we log the precise reason and move on.
 * The operator then sees exactly which destinations need manual
 * attention BEFORE they can safely flip the flag.
 *
 * Invocation (identical shape to stage-d-v3-migrate.mjs so muscle memory
 * from the earlier migration carries over cleanly):
 *
 *   railway run --service targenix.uz node \
 *     tooling/mysql/_stage3-link-connectionid.mjs \
 *     --expected-key-hash=<prod-hash> \
 *     [--dry-run | --apply] \
 *     [--user-id=<N>]
 *
 * Hard guards (any violation → immediate abort, no DB connection opened):
 *   • NO dotenv import — local `.env` must not shadow Railway env vars.
 *   • `RAILWAY_PROJECT_ID` must be set (proves `railway run` context).
 *   • `--expected-key-hash` must match `sha256(ENCRYPTION_KEY)`.
 *   • Must pass exactly one of `--dry-run` / `--apply`.
 */

import crypto from "node:crypto";
import mysql from "mysql2/promise";

// ─── Hard guards ────────────────────────────────────────────────────────────
function abort(msg) {
  console.error(`[stage3-link] ABORT: ${msg}`);
  process.exit(1);
}

if (!process.env.RAILWAY_PROJECT_ID) {
  abort(
    "RAILWAY_PROJECT_ID not set — this script MUST run via " +
      "`railway run --service targenix.uz node …`. Never run it locally.",
  );
}

const rawKey = process.env.ENCRYPTION_KEY;
if (!rawKey) abort("ENCRYPTION_KEY not set in the injected environment.");
if (rawKey.length !== 32) {
  abort(
    `ENCRYPTION_KEY length is ${rawKey.length}; must be 32 — aborting to ` +
      "avoid silent key mismatch (same rule as server/_core/validateEnv.ts).",
  );
}

const mysqlUrl =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!mysqlUrl) abort("MYSQL_PUBLIC_URL / MYSQL_URL missing.");

const KEY_HASH = crypto.createHash("sha256").update(rawKey).digest("hex");

// ─── CLI parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}`) !== undefined;
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const DRY_RUN = flag("dry-run");
const APPLY = flag("apply");
const EXPECTED_KEY_HASH = value("expected-key-hash");
const USER_ID_RAW = value("user-id");
const USER_ID = USER_ID_RAW == null ? null : Number.parseInt(USER_ID_RAW, 10);
if (USER_ID_RAW != null && (!Number.isFinite(USER_ID) || USER_ID <= 0)) {
  abort(`--user-id must be a positive integer (got "${USER_ID_RAW}")`);
}

if (!DRY_RUN && !APPLY) abort("Pass exactly one of --dry-run or --apply.");
if (DRY_RUN && APPLY) abort("--dry-run and --apply are mutually exclusive.");
if (!EXPECTED_KEY_HASH) {
  abort(
    "--expected-key-hash=<sha256 hex> is required. Fetch it with:\n" +
      `  railway run --service targenix.uz node -e "console.log(require('crypto').createHash('sha256').update(process.env.ENCRYPTION_KEY).digest('hex'))"`,
  );
}
if (EXPECTED_KEY_HASH !== KEY_HASH) {
  console.error(`[stage3-link] KEY_HASH (live)     = ${KEY_HASH}`);
  console.error(`[stage3-link] KEY_HASH (expected) = ${EXPECTED_KEY_HASH}`);
  abort(
    "ENCRYPTION_KEY hash mismatch — refusing to proceed. Same guard as Stage D v3.",
  );
}

// ─── Banner ─────────────────────────────────────────────────────────────────
console.log("─".repeat(72));
console.log("  STAGE 3 Phase 3 — connectionId backfill");
console.log("─".repeat(72));
console.log(`  MODE            : ${DRY_RUN ? "DRY-RUN (read-only)" : "APPLY"}`);
console.log(`  SCOPE           : ${USER_ID ? `userId=${USER_ID}` : "ALL USERS"}`);
console.log(`  RAILWAY_ENV     : ${process.env.RAILWAY_ENVIRONMENT ?? "?"}`);
console.log(`  RAILWAY_SERVICE : ${process.env.RAILWAY_SERVICE_NAME ?? "?"}`);
console.log(`  KEY_HASH        : ${KEY_HASH}`);
console.log("─".repeat(72));

// ─── Crypto helpers (mirror server/encryption.ts byte-for-byte) ─────────────
function getAesKey() {
  return crypto.createHash("sha256").update(rawKey).digest();
}
function decryptValue(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(":");
  if (!ivHex || !encHex) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", getAesKey(), iv);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString("utf8");
}

function tryDecrypt(value) {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  try {
    return { ok: true, plaintext: decryptValue(value) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Reason codes for skipped rows ──────────────────────────────────────────
// Every non-linked row is classified with one of these so the operator
// has a concrete list to chase rather than "unknown error".
const SKIP = {
  NO_TEMPLATE: "NO_TEMPLATE",         // targetWebsite.templateId doesn't resolve
  NO_APPKEY: "NO_APPKEY",             // template has no appKey (can't match connection)
  EMPTY_SECRETS: "EMPTY_SECRETS",     // no secrets to migrate (already connection-only)
  NO_CONNECTION: "NO_CONNECTION",     // user has zero active connections for this appKey
  AMBIGUOUS: "AMBIGUOUS",             // user has >1 active connections for this appKey
  CONN_NO_SECRETS: "CONN_NO_SECRETS", // matched connection has no secretsEncrypted map
  SECRET_MISMATCH: "SECRET_MISMATCH", // tw.secrets vs conn.secrets plaintexts differ
  DECRYPT_FAIL: "DECRYPT_FAIL",       // ciphertext on either side cannot be decrypted
};

// ─── Main ───────────────────────────────────────────────────────────────────
const conn = await mysql.createConnection(mysqlUrl);
try {
  // Select every active destination that still carries a secrets map and
  // is not yet linked to a connection. We join `destination_templates`
  // for `appKey`, which is how we match users' connections.
  const userFilter = USER_ID ? `AND tw.userId = ${USER_ID}` : "";
  const [rows] = await conn.query(
    `
    SELECT
      tw.id              AS twId,
      tw.userId          AS userId,
      tw.name            AS twName,
      tw.templateId      AS templateId,
      tw.templateConfig  AS templateConfig,
      dt.appKey          AS templateAppKey,
      dt.name            AS templateName
    FROM target_websites tw
    LEFT JOIN destination_templates dt ON dt.id = tw.templateId
    WHERE tw.isActive = 1
      AND tw.connectionId IS NULL
      ${userFilter}
    ORDER BY tw.id ASC
    `,
  );

  const candidates = [];
  const skipped = [];

  for (const row of rows) {
    const cfg =
      typeof row.templateConfig === "string"
        ? safeJsonParse(row.templateConfig)
        : row.templateConfig ?? null;
    const secrets =
      cfg &&
      typeof cfg === "object" &&
      cfg.secrets &&
      typeof cfg.secrets === "object" &&
      !Array.isArray(cfg.secrets)
        ? cfg.secrets
        : null;

    if (!secrets || Object.keys(secrets).length === 0) {
      skipped.push({ twId: row.twId, reason: SKIP.EMPTY_SECRETS, detail: null });
      continue;
    }
    if (!row.templateId) {
      skipped.push({ twId: row.twId, reason: SKIP.NO_TEMPLATE, detail: null });
      continue;
    }
    if (!row.templateAppKey) {
      skipped.push({
        twId: row.twId,
        reason: SKIP.NO_APPKEY,
        detail: { templateId: row.templateId, templateName: row.templateName },
      });
      continue;
    }

    // Find the user's active connections for this appKey.
    const [connMatches] = await conn.query(
      `
      SELECT id, credentialsJson, status, displayName
      FROM connections
      WHERE userId = ?
        AND appKey = ?
        AND status = 'active'
      `,
      [row.userId, row.templateAppKey],
    );

    if (connMatches.length === 0) {
      skipped.push({
        twId: row.twId,
        reason: SKIP.NO_CONNECTION,
        detail: { userId: row.userId, appKey: row.templateAppKey },
      });
      continue;
    }
    if (connMatches.length > 1) {
      skipped.push({
        twId: row.twId,
        reason: SKIP.AMBIGUOUS,
        detail: {
          userId: row.userId,
          appKey: row.templateAppKey,
          connectionIds: connMatches.map((c) => c.id),
        },
      });
      continue;
    }

    const [match] = connMatches;
    const matchCreds =
      typeof match.credentialsJson === "string"
        ? safeJsonParse(match.credentialsJson)
        : match.credentialsJson ?? null;
    const connSecrets =
      matchCreds &&
      typeof matchCreds === "object" &&
      matchCreds.secretsEncrypted &&
      typeof matchCreds.secretsEncrypted === "object" &&
      !Array.isArray(matchCreds.secretsEncrypted)
        ? matchCreds.secretsEncrypted
        : null;

    if (!connSecrets || Object.keys(connSecrets).length === 0) {
      skipped.push({
        twId: row.twId,
        reason: SKIP.CONN_NO_SECRETS,
        detail: { connectionId: match.id },
      });
      continue;
    }

    // Verify every key present on the destination ALSO exists on the
    // connection AND decrypts to the same plaintext. Extra keys on the
    // connection are fine (user may have added a secret that the
    // template will start using in the future).
    const mismatches = [];
    let decryptFailure = null;
    for (const [key, twCipher] of Object.entries(secrets)) {
      const connCipher = connSecrets[key];
      if (typeof connCipher !== "string" || connCipher.length === 0) {
        mismatches.push({ key, reason: "missing_on_connection" });
        continue;
      }
      const twDec = tryDecrypt(twCipher);
      const connDec = tryDecrypt(connCipher);
      if (!twDec.ok) {
        decryptFailure = { side: "destination", key, error: twDec.reason };
        break;
      }
      if (!connDec.ok) {
        decryptFailure = { side: "connection", key, error: connDec.reason };
        break;
      }
      if (twDec.plaintext !== connDec.plaintext) {
        mismatches.push({ key, reason: "plaintext_differs" });
      }
    }

    if (decryptFailure) {
      skipped.push({
        twId: row.twId,
        reason: SKIP.DECRYPT_FAIL,
        detail: { connectionId: match.id, ...decryptFailure },
      });
      continue;
    }
    if (mismatches.length > 0) {
      skipped.push({
        twId: row.twId,
        reason: SKIP.SECRET_MISMATCH,
        detail: { connectionId: match.id, mismatches },
      });
      continue;
    }

    candidates.push({
      twId: row.twId,
      twName: row.twName,
      userId: row.userId,
      appKey: row.templateAppKey,
      connectionId: match.id,
      connectionName: match.displayName,
      secretKeys: Object.keys(secrets),
    });
  }

  // ─── Report ──────────────────────────────────────────────────────────────
  console.log(`\n[stage3-link] Scanned ${rows.length} active unlinked destinations.`);
  console.log(`[stage3-link]   SAFE TO LINK : ${candidates.length}`);
  console.log(`[stage3-link]   SKIPPED      : ${skipped.length}`);

  if (skipped.length > 0) {
    const byReason = {};
    for (const s of skipped) {
      byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
    }
    console.log("[stage3-link]   skip breakdown:");
    for (const [reason, n] of Object.entries(byReason)) {
      console.log(`[stage3-link]     ${reason.padEnd(16)} ${n}`);
    }
  }

  if (candidates.length > 0) {
    console.log("\n[stage3-link] SAFE candidates:");
    for (const c of candidates) {
      console.log(
        `[stage3-link]   tw=${c.twId} "${c.twName}" user=${c.userId} ` +
          `appKey=${c.appKey} → connection=${c.connectionId} "${c.connectionName ?? ""}" ` +
          `keys=[${c.secretKeys.join(",")}]`,
      );
    }
  }

  if (skipped.length > 0) {
    console.log("\n[stage3-link] SKIPPED rows (need operator attention):");
    for (const s of skipped) {
      console.log(
        `[stage3-link]   tw=${s.twId} reason=${s.reason} ${
          s.detail ? JSON.stringify(s.detail) : ""
        }`,
      );
    }
  }

  if (DRY_RUN) {
    console.log("\n[stage3-link] DRY-RUN complete — no rows modified.");
    process.exit(0);
  }

  // ─── Apply ──────────────────────────────────────────────────────────────
  if (candidates.length === 0) {
    console.log("\n[stage3-link] Nothing to link. Exiting cleanly.");
    process.exit(0);
  }

  console.log(`\n[stage3-link] APPLY — linking ${candidates.length} row(s)…`);
  await conn.beginTransaction();
  try {
    let linked = 0;
    for (const c of candidates) {
      // `connectionId IS NULL` in the WHERE clause makes this a no-op if
      // something raced us (concurrent create/link). That makes the script
      // safe to re-run without accidentally overwriting a newer link.
      const [res] = await conn.query(
        `UPDATE target_websites SET connectionId = ? WHERE id = ? AND connectionId IS NULL`,
        [c.connectionId, c.twId],
      );
      const affected = res?.affectedRows ?? 0;
      if (affected === 1) {
        linked += 1;
        console.log(
          `[stage3-link]   linked tw=${c.twId} → connection=${c.connectionId}`,
        );
      } else {
        console.warn(
          `[stage3-link]   SKIP-RACE tw=${c.twId} (connectionId already set by concurrent writer)`,
        );
      }
    }
    await conn.commit();
    console.log(`\n[stage3-link] COMMIT — linked ${linked}/${candidates.length} row(s).`);
  } catch (err) {
    await conn.rollback();
    console.error("[stage3-link] ROLLBACK — unexpected error during apply:", err);
    process.exit(2);
  }
} finally {
  await conn.end();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
