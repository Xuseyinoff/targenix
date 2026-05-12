import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection({ uri: process.env.DATABASE_URL });

const [totals] = await conn.query(
  `SELECT COUNT(*) AS total FROM integrations`,
);
const [legacy] = await conn.query(
  `SELECT COUNT(*) AS withLegacy
     FROM integrations
    WHERE JSON_EXTRACT(config, '$.targetWebsiteId') IS NOT NULL`,
);
const [overlap] = await conn.query(
  `SELECT COUNT(*) AS withBoth
     FROM integrations
    WHERE JSON_EXTRACT(config, '$.targetWebsiteId') IS NOT NULL
      AND JSON_EXTRACT(config, '$.destinationId') IS NOT NULL`,
);
const [modern] = await conn.query(
  `SELECT COUNT(*) AS withModern
     FROM integrations
    WHERE JSON_EXTRACT(config, '$.destinationId') IS NOT NULL`,
);

console.log({
  totalIntegrations: Number(totals[0].total),
  withLegacyTargetWebsiteId: Number(legacy[0].withLegacy),
  withModernDestinationId: Number(modern[0].withModern),
  withBoth: Number(overlap[0].withBoth),
});

// Sample 5 mismatches where legacy is set but modern is not, OR they disagree
const [mismatches] = await conn.query(
  `SELECT id,
          JSON_EXTRACT(config, '$.targetWebsiteId') AS legacy,
          JSON_EXTRACT(config, '$.destinationId') AS modern,
          destinationId AS columnVal
     FROM integrations
    WHERE JSON_EXTRACT(config, '$.targetWebsiteId') IS NOT NULL
      AND (
        JSON_EXTRACT(config, '$.destinationId') IS NULL
        OR JSON_UNQUOTE(JSON_EXTRACT(config, '$.targetWebsiteId'))
           <> JSON_UNQUOTE(JSON_EXTRACT(config, '$.destinationId'))
      )
    LIMIT 5`,
);
console.log("\nSample mismatches:");
console.table(mismatches);

await conn.end();
