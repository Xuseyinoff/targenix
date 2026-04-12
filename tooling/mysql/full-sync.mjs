/**
 * Full MySQL dump from SOURCE URL → import into TARGET URL (Railway → local, etc.).
 *
 * Dump: `mysqldump` CLI if on PATH, else npm package `mysqldump` (JS).
 * Import: `mysql` CLI (PATH or common Windows paths) with streaming stdin — required for large dumps.
 *
 * Optional: FORCE_RECREATE_TARGET=1 — DROP + CREATE empty target DB before import (mysql root).
 *
 * Usage (PowerShell):
 *   $env:SOURCE_MYSQL_URL = "mysql://..."
 *   $env:TARGET_MYSQL_URL = "mysql://..."
 *   $env:FORCE_RECREATE_TARGET = "1"   # first-time full clone
 *   pnpm db:sync:railway-to-local
 */

import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, createReadStream, mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dumpsDir = join(__dirname, "dumps");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function parseMysqlUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  if (u.protocol !== "mysql:") return null;
  const database = u.pathname.replace(/^\//, "").split("?")[0];
  if (!database) die("URL must include database name, e.g. mysql://user:pass@host:3306/dbname");
  return {
    host: u.hostname,
    port: u.port || "3306",
    user: decodeURIComponent(u.username || "root"),
    password: u.password !== "" && u.password != null ? decodeURIComponent(u.password) : "",
    database,
  };
}

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

/** Find mysql.exe / mysqldump.exe on Windows when not on PATH */
function findWinMysqlBin(name) {
  const exe = `${name}.exe`;
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pfx86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    join(pf, "MySQL", "MySQL Server 8.4", "bin", exe),
    join(pf, "MySQL", "MySQL Server 8.0", "bin", exe),
    join(pf, "MySQL", "MySQL Server 5.7", "bin", exe),
    join(pf, "MariaDB 10.11", "bin", exe),
    join(pf, "MariaDB 10.6", "bin", exe),
    join(pfx86, "MySQL", "MySQL Server 8.0", "bin", exe),
    "C:\\xampp\\mysql\\bin\\" + exe,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function resolveMysqlCli(name) {
  if (which(name)) return name;
  if (process.platform === "win32") {
    const p = findWinMysqlBin(name);
    if (p) return p;
  }
  return null;
}

function needsSsl(host) {
  return /rlwy\.net|railway\.app|amazonaws\.com/i.test(host);
}

function dumpArgs(src) {
  return [
    "-h",
    src.host,
    "-P",
    String(src.port),
    "-u",
    src.user,
    ...(src.password ? [`-p${src.password}`] : []),
    "--single-transaction",
    "--routines",
    "--triggers",
    "--set-gtid-purged=OFF",
    "--column-statistics=0",
    "--add-drop-table",
    src.database,
  ];
}

function mysqlImportArgs(tgt) {
  return [
    "-h",
    tgt.host,
    "-P",
    String(tgt.port),
    "-u",
    tgt.user,
    ...(tgt.password ? [`-p${tgt.password}`] : []),
    "--max_allowed_packet=1073741824",
    tgt.database,
  ];
}

async function runMysqldumpToFileCli(mysqldumpBin, src, filePath) {
  const p = spawn(mysqldumpBin, dumpArgs(src), { stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", (d) => process.stderr.write(d));
  const out = createWriteStream(filePath);
  await pipeline(p.stdout, out);
  const [code] = await once(p, "close");
  if (code !== 0) throw new Error(`mysqldump exited ${code}`);
}

async function runMysqlFromFileCli(mysqlBin, tgt, filePath) {
  const p = spawn(mysqlBin, mysqlImportArgs(tgt), { stdio: ["pipe", "pipe", "pipe"] });
  p.stderr.on("data", (d) => process.stderr.write(d));
  const inp = createReadStream(filePath);
  await pipeline(inp, p.stdin);
  const [code] = await once(p, "close");
  if (code !== 0) throw new Error(`mysql exited ${code}`);
}

async function runDumpJs(src, dumpPath) {
  const mod = await import("mysqldump");
  const mysqldump = mod.default;
  const connection = {
    host: src.host,
    port: Number(src.port),
    user: src.user,
    password: src.password,
    database: src.database,
  };
  if (needsSsl(src.host)) {
    connection.ssl = { rejectUnauthorized: false };
  }
  await mysqldump({ connection, dumpToFile: dumpPath });
}

async function recreateTargetDb(mysqlBin, tgt) {
  const args = [
    "-h",
    tgt.host,
    "-P",
    String(tgt.port),
    "-u",
    tgt.user,
    ...(tgt.password ? [`-p${tgt.password}`] : []),
    "-e",
    `DROP DATABASE IF EXISTS \`${tgt.database.replace(/`/g, "")}\`; CREATE DATABASE \`${tgt.database.replace(/`/g, "")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`,
  ];
  const p = spawnSync(mysqlBin, args, { encoding: "utf8" });
  if (p.status !== 0) {
    die(`Failed to recreate database: ${p.stderr || p.stdout || p.error}`);
  }
  console.log(`[sync] Recreated empty database \`${tgt.database}\`.`);
}

const source =
  process.env.SOURCE_MYSQL_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  process.env.RAILWAY_MYSQL_URL;
const target =
  process.env.TARGET_MYSQL_URL ||
  process.env.LOCAL_MYSQL_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;

const src = parseMysqlUrl(source);
const tgt = parseMysqlUrl(target);

if (!src) {
  die(
    "Set SOURCE_MYSQL_URL (or MYSQL_PUBLIC_URL) to the Railway TCP mysql://… URL including database name.",
  );
}
if (!tgt) {
  die(
    "Set TARGET_MYSQL_URL (or LOCAL_MYSQL_URL, or MYSQL_URL from .env) to your local mysql://… URL including database name.",
  );
}

if (src.host === tgt.host && src.port === tgt.port && src.database === tgt.database) {
  die("Source and target look identical — refusing to run.");
}

mkdirSync(dumpsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dumpPath = join(dumpsDir, `full_sync_${stamp}.sql`);

const mysqldumpBin = resolveMysqlCli("mysqldump");
const mysqlBin = resolveMysqlCli("mysql");

try {
  console.log(`[sync] Dumping ${src.user}@${src.host}:${src.port}/${src.database} → ${dumpPath}`);
  if (mysqldumpBin) {
    await runMysqldumpToFileCli(mysqldumpBin, src, dumpPath);
  } else {
    console.log("[sync] mysqldump CLI not found — using npm mysqldump (JS).");
    await runDumpJs(src, dumpPath);
  }
} catch (e) {
  die(String(e));
}

const dumpBytes = statSync(dumpPath).size;
console.log(`[sync] Dump size: ${(dumpBytes / (1024 * 1024)).toFixed(1)} MiB`);

if (!mysqlBin) {
  die(
    "[sync] mysql CLI not found (PATH or Program Files). Large imports need:\n" +
      '  "C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe" -h 127.0.0.1 -u root -p ... --max_allowed_packet=1G targenix < dump.sql',
  );
}

if (process.env.FORCE_RECREATE_TARGET === "1" || process.env.FORCE_RECREATE_TARGET === "true") {
  await recreateTargetDb(mysqlBin, tgt);
}

try {
  console.log(`[sync] Importing via ${mysqlBin} → ${tgt.user}@${tgt.host}:${tgt.port}/${tgt.database} …`);
  await runMysqlFromFileCli(mysqlBin, tgt, dumpPath);
} catch (e) {
  console.error(String(e));
  console.error(`[sync] If you see duplicate key errors, run with FORCE_RECREATE_TARGET=1 once.`);
  console.error(`[sync] Dump file: ${dumpPath}`);
  process.exit(1);
}

console.log("[sync] Done. Point local .env MYSQL_URL at this DB and restart `pnpm dev`.");
console.log(`[sync] Dump kept at: ${dumpPath}`);
