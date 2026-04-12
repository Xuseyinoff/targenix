/** Max completed delivery tries per order (initial try + timed retries). */
export const ORDER_MAX_DELIVERY_ATTEMPTS = 3;

/** Wall-clock spacing between automatic order retries */
export const ORDER_RETRY_INTERVAL_MS = 60 * 60 * 1000;
