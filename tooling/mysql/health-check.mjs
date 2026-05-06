/**
 * Full system health check — leads, orders, integrations, queue.
 * Usage: railway run --service MySQL node tooling/mysql/health-check.mjs
 */
import mysql from "mysql2/promise";

const urls = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.MYSQL_URL,
  process.env.DATABASE_URL,
].filter(Boolean);

let cn;
for (const url of urls) {
  try { cn = await mysql.createConnection(url); break; } catch {}
}
if (!cn) { console.error("❌ No DB reachable"); process.exit(1); }

const ok  = (label, value) => console.log(`  ✓ ${label.padEnd(40)} ${value}`);
const err = (label, value) => console.log(`  ✗ ${label.padEnd(40)} ${value}`);
const warn = (label, value) => console.log(`  ⚠ ${label.padEnd(40)} ${value}`);
const row = (label, value, isOk) => (isOk ? ok : err)(label, value);

// returns rows[]
const q = async (sql, params = []) => {
  const [rows] = await cn.query(sql, params);
  return rows;
};

// ─── 1. LEAD PROCESSING ───────────────────────────────────────────────────────
console.log("\n══ 1. LEAD PROCESSING (so'nggi 24 soat) ══════════════════════════");

const lStats = await q(`
  SELECT dataStatus, deliveryStatus, COUNT(*) as cnt
  FROM leads
  WHERE createdAt >= NOW() - INTERVAL 24 HOUR
  GROUP BY dataStatus, deliveryStatus
`);

const sum = (rows, fn) => rows.filter(fn).reduce((s, r) => s + Number(r.cnt), 0);
const lTotal     = sum(lStats, () => true);
const lEnriched  = sum(lStats, r => r.dataStatus === "ENRICHED");
const lError     = sum(lStats, r => r.dataStatus === "ERROR");
const lSuccess   = sum(lStats, r => r.deliveryStatus === "SUCCESS");
const lFailed    = sum(lStats, r => r.deliveryStatus === "FAILED");
const lPartial   = sum(lStats, r => r.deliveryStatus === "PARTIAL");
const lStuckPend = sum(lStats, r => r.deliveryStatus === "PENDING" && r.dataStatus !== "ERROR");

row("Jami leadlar (24h)",                String(lTotal), true);
row("Ma'lumot olindi — ENRICHED",        `${lEnriched}/${lTotal}`, lError === 0);
row("Facebook xatosi — ERROR",           String(lError), lError === 0);
row("Integratsiyaga yuborildi — SUCCESS", String(lSuccess), true);
row("Yuborishda xato — FAILED",          String(lFailed), lFailed === 0);
if (lPartial > 0) warn("Qisman yuborildi — PARTIAL",   String(lPartial));
row("Kutilmoqda (PENDING) — stuck?",     String(lStuckPend), lStuckPend < 5);

// ─── 2. STUCK LEADS ───────────────────────────────────────────────────────────
console.log("\n══ 2. STUCK LEADLAR (15+ daqiqa PENDING, no ERROR) ═══════════════");

const stuck = await q(`
  SELECT id, userId, dataStatus, deliveryStatus, dataError,
         TIMESTAMPDIFF(MINUTE, createdAt, NOW()) as age_min
  FROM leads
  WHERE deliveryStatus = 'PENDING'
    AND dataStatus != 'ERROR'
    AND createdAt < NOW() - INTERVAL 15 MINUTE
  ORDER BY createdAt DESC
  LIMIT 10
`);

if (stuck.length === 0) {
  ok("Stuck lead yo'q", "✓ Toza");
} else {
  err("Stuck leadlar", `${stuck.length} ta`);
  stuck.forEach(r =>
    console.log(`     id=${r.id} userId=${r.userId} age=${r.age_min}min data=${r.dataStatus} delivery=${r.deliveryStatus}`)
  );
}

// ─── 3. ORDER DELIVERY ────────────────────────────────────────────────────────
console.log("\n══ 3. ORDER DELIVERY (so'nggi 24 soat) ════════════════════════════");

const oStats = await q(`
  SELECT status, COUNT(*) as cnt
  FROM orders
  WHERE createdAt >= NOW() - INTERVAL 24 HOUR
  GROUP BY status
`);

const oTotal   = oStats.reduce((s, r) => s + Number(r.cnt), 0);
const oSent    = Number(oStats.find(r => r.status === "SENT")?.cnt   || 0);
const oFailed  = Number(oStats.find(r => r.status === "FAILED")?.cnt || 0);
const oPending = Number(oStats.find(r => r.status === "PENDING")?.cnt || 0);

row("Jami orderlar (24h)",       String(oTotal), true);
row("Muvaffaqiyatli — SENT",     String(oSent),   oFailed === 0);
row("Xato — FAILED",             String(oFailed), oFailed === 0);
row("Kutilmoqda — PENDING",      String(oPending), oPending < 20);

// ─── 4. FAILED ORDERS DETAIL ─────────────────────────────────────────────────
const recentFailed = await q(`
  SELECT o.id, o.userId, o.integrationId, o.attempts,
         i.name as intgName,
         TIMESTAMPDIFF(MINUTE, o.createdAt, NOW()) as age_min
  FROM orders o
  LEFT JOIN integrations i ON i.id = o.integrationId
  WHERE o.status = 'FAILED'
    AND o.createdAt >= NOW() - INTERVAL 24 HOUR
  ORDER BY o.createdAt DESC
  LIMIT 8
`);

if (recentFailed.length > 0) {
  console.log(`\n  So'nggi xato orderlar:`);
  recentFailed.forEach(r =>
    console.log(`    orderId=${r.id} intg="${r.intgName||r.integrationId}" attempts=${r.attempts} age=${r.age_min}min`)
  );
}

// ─── 5. INTEGRATION HEALTH ───────────────────────────────────────────────────
console.log("\n══ 5. INTEGRATIONS (faol, 24h) ════════════════════════════════════");

const intgStats = await q(`
  SELECT i.id, i.name, u.email as userEmail,
    COUNT(o.id)              as total,
    SUM(o.status = 'SENT')   as sent,
    SUM(o.status = 'FAILED') as failed,
    MAX(o.createdAt)         as lastOrder
  FROM integrations i
  JOIN users u ON u.id = i.userId
  LEFT JOIN orders o ON o.integrationId = i.id
    AND o.createdAt >= NOW() - INTERVAL 24 HOUR
  WHERE i.type = 'LEAD_ROUTING' AND i.isActive = 1
  GROUP BY i.id, i.name, u.email
  ORDER BY total DESC
  LIMIT 30
`);

const totalIntg   = intgStats.length;
const brokenIntg  = intgStats.filter(r => Number(r.failed) > 0);
const activeIntg  = intgStats.filter(r => Number(r.total)  > 0);
const silentIntg  = intgStats.filter(r => Number(r.total) === 0);

row("Faol integrations soni",        String(totalIntg),           true);
row("24h da lead keldi",             String(activeIntg.length),   true);
row("Xatosiz ishladi",               `${totalIntg - brokenIntg.length}/${totalIntg}`, brokenIntg.length === 0);

if (brokenIntg.length > 0) {
  console.log(`\n  ✗ Xatoli integrations:`);
  brokenIntg.forEach(r =>
    console.log(`    intg=${r.id} "${r.name}" (${r.userEmail}) sent=${r.sent} failed=${r.failed}`)
  );
}

if (silentIntg.length > 0) {
  console.log(`\n  ⚠ 24h da lead kelmagan integrations (${silentIntg.length} ta — reklama to'xtadimi?):`);
  silentIntg.slice(0, 5).forEach(r =>
    console.log(`    intg=${r.id} "${r.name}" (${r.userEmail})`)
  );
}

// ─── 6. LEADS WITH NO MATCHING INTEGRATION ───────────────────────────────────
console.log("\n══ 6. INTEGRATION TOPA OLMAGAN LEADLAR (24h) ══════════════════════");

const dropped = await q(`
  SELECT l.userId, u.email, COUNT(*) as cnt
  FROM leads l
  JOIN users u ON u.id = l.userId
  WHERE l.dataStatus = 'ENRICHED'
    AND l.createdAt >= NOW() - INTERVAL 24 HOUR
    AND NOT EXISTS (
      SELECT 1 FROM orders o WHERE o.leadId = l.id
    )
  GROUP BY l.userId, u.email
`);

const droppedTotal = dropped.reduce((s, r) => s + Number(r.cnt), 0);
row("Integration topa olmagan lead", droppedTotal === 0 ? "✓ Yo'q" : `${droppedTotal} ta`, droppedTotal === 0);
if (droppedTotal > 0) {
  dropped.forEach(r =>
    console.log(`    userId=${r.userId} (${r.email}): ${r.cnt} ta lead — integration ulangan emas`)
  );
}

// ─── 7. BULLMQ QUEUE ──────────────────────────────────────────────────────────
console.log("\n══ 7. BULLMQ QUEUE ══════════════════════════════════════════════════");

await cn.end();

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  err("BullMQ", "REDIS_URL yo'q");
} else {
  try {
    const { Queue } = await import("bullmq");
    const u = new URL(redisUrl);
    const queue = new Queue("lead-processing", {
      connection: {
        host: u.hostname, port: Number(u.port) || 6379,
        password: u.password || undefined,
        db: u.pathname ? Number(u.pathname.replace("/", "")) || 0 : 0,
        tls: u.protocol === "rediss:" ? {} : undefined,
      },
    });
    const [waiting, active, failed, delayed, completed] = await Promise.all([
      queue.getWaitingCount(), queue.getActiveCount(),
      queue.getFailedCount(),  queue.getDelayedCount(),
      queue.getCompletedCount(),
    ]);
    await queue.close();

    row("Waiting (navbatda)",           String(waiting),   waiting < 50);
    row("Active (ishlanmoqda)",          String(active),    active <= 5);
    row("Failed (xato, qayta urining!)", String(failed),    failed === 0);
    row("Delayed (rejalashtirilgan)",    String(delayed),   true);
    ok ("Completed (muvaffaqiyatli)",    String(completed));
  } catch (e) {
    err("BullMQ ulanib bo'lmadi", e.message);
  }
}

// ─── XULOSA ───────────────────────────────────────────────────────────────────
console.log("\n════════════════════════════════════════════════════════════════════\n");
