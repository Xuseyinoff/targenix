import IORedis from "ioredis";

let _connection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!_connection) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    _connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });

    _connection.on("connect", () => console.log("[Redis] Connected"));
    _connection.on("error", (err) => console.error("[Redis] Error:", err.message));
  }
  return _connection;
}
