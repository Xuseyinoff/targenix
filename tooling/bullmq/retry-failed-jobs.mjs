/**
 * Retry all failed BullMQ jobs in the lead-processing queue.
 * Usage: railway run node tooling/bullmq/retry-failed-jobs.mjs
 */
import { Queue } from "bullmq";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("REDIS_URL not set");
  process.exit(1);
}

// Parse redis://[:password@]host:port[/db]
const url = new URL(REDIS_URL);
const connection = {
  host: url.hostname,
  port: Number(url.port) || 6379,
  password: url.password || undefined,
  db: url.pathname ? Number(url.pathname.replace("/", "")) || 0 : 0,
  tls: url.protocol === "rediss:" ? {} : undefined,
};

const queue = new Queue("lead-processing", { connection });

// Count first
const [failedCount, waitingCount, activeCount] = await Promise.all([
  queue.getFailedCount(),
  queue.getWaitingCount(),
  queue.getActiveCount(),
]);

console.log(`Queue state:`);
console.log(`  failed:  ${failedCount}`);
console.log(`  waiting: ${waitingCount}`);
console.log(`  active:  ${activeCount}`);

if (failedCount === 0) {
  console.log("\nNo failed jobs to retry.");
  await queue.close();
  process.exit(0);
}

console.log(`\nRetrying ${failedCount} failed jobs...`);

// Fetch and retry in batches of 100
let retried = 0;
let errors = 0;
const batchSize = 100;
let start = 0;

while (true) {
  const jobs = await queue.getFailed(start, start + batchSize - 1);
  if (jobs.length === 0) break;

  await Promise.all(
    jobs.map(async (job) => {
      try {
        await job.retry();
        retried++;
      } catch (e) {
        errors++;
        console.error(`  Failed to retry job ${job.id}:`, e.message);
      }
    })
  );

  console.log(`  Processed batch: ${start}–${start + jobs.length - 1}`);
  start += batchSize;

  if (jobs.length < batchSize) break;
}

console.log(`\nDone. Retried: ${retried} | Errors: ${errors}`);

await queue.close();
