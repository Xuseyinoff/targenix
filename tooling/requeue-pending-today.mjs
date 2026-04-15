/**
 * Apr 15 da PENDING qolgan leadlarni BullMQ ga qayta yuborish.
 * Worker hozir ishlamoqda — ular avtomatik ishlanadi.
 */
import mysql from "mysql2/promise";
import { Queue } from "bullmq";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const dbUrl = candidates
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

const redisUrl = process.env.REDIS_URL;

if (!dbUrl) { console.error("❌ DB URL topilmadi"); process.exit(1); }
if (!redisUrl) { console.error("❌ REDIS_URL topilmadi"); process.exit(1); }

console.log("✅ DB va Redis URL topildi");

const conn = await mysql.createConnection(dbUrl);

// Apr 15 (UTC) dagi PENDING leadlar
const [pendingLeads] = await conn.query(
  `SELECT id, leadgenId, pageId, formId, userId
   FROM leads
   WHERE DATE(createdAt) = '2026-04-15'
     AND dataStatus = 'PENDING'
   ORDER BY createdAt ASC`
);

console.log(`\nApr 15 PENDING leadlar soni: ${pendingLeads.length}`);

if (pendingLeads.length === 0) {
  console.log("✅ Hech qanday PENDING lead yo'q, hamma yaxshi!");
  await conn.end();
  process.exit(0);
}

// Redis ga ulanish
const queue = new Queue("lead-processing", {
  connection: { url: redisUrl },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 60 * 60 * 24 },
    removeOnFail: { age: 60 * 60 * 24 * 7 },
  },
});

let queued = 0;
let skipped = 0;

for (const lead of pendingLeads) {
  const jobId = `lead-${lead.id}`;

  // Mavjud jobni tekshirish
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "active" || state === "delayed") {
      skipped++;
      continue;
    }
  }

  await queue.add(
    "process-lead",
    {
      leadId: lead.id,
      leadgenId: lead.leadgenId,
      pageId: lead.pageId,
      formId: lead.formId,
      userId: lead.userId,
    },
    { jobId }
  );
  queued++;
}

console.log(`\n✅ Natija:`);
console.log(`   Queue ga qo'shildi: ${queued}`);
console.log(`   Allaqachon navbatda: ${skipped}`);
console.log(`   Jami: ${pendingLeads.length}`);
console.log(`\nWorker ularni hozir ishlatadi 🚀`);

await queue.close();
await conn.end();
