import mysql from "mysql2/promise";

const c = await mysql.createConnection({
  uri: process.env.MYSQL_PUBLIC_URL,
  multipleStatements: false,
});

const run = async (label, sql) => {
  try {
    await c.execute(sql);
    console.log(`✅  ${label}`);
  } catch (err) {
    console.log(`❌  ${label}  → ${err.code}: ${err.sqlMessage}`);
    throw err;
  }
};

console.log("\n=== Applying migration 0043 to production ===\n");

// Step 1: create connections table (no FK yet — we'll add FKs after)
await run(
  "1. CREATE TABLE connections",
  `CREATE TABLE \`connections\` (
    \`id\`              int NOT NULL AUTO_INCREMENT,
    \`userId\`          int NOT NULL,
    \`type\`            ENUM('google_sheets','telegram_bot','api_key') NOT NULL,
    \`displayName\`     varchar(255) NOT NULL,
    \`status\`          ENUM('active','expired','revoked','error') NOT NULL DEFAULT 'active',
    \`googleAccountId\` int NULL,
    \`credentialsJson\` json NULL,
    \`lastVerifiedAt\`  timestamp NULL,
    \`createdAt\`       timestamp NOT NULL DEFAULT (now()),
    \`updatedAt\`       timestamp NOT NULL DEFAULT (now()) ON UPDATE now(),
    CONSTRAINT \`connections_id\` PRIMARY KEY (\`id\`),
    KEY \`idx_connections_user_id\`   (\`userId\`),
    KEY \`idx_connections_user_type\` (\`userId\`, \`type\`)
  )`,
);

// Step 2: add FK from connections.googleAccountId → google_accounts.id
await run(
  "2. ADD FK fk_connections_google_account",
  `ALTER TABLE \`connections\`
    ADD CONSTRAINT \`fk_connections_google_account\`
    FOREIGN KEY (\`googleAccountId\`)
    REFERENCES \`google_accounts\` (\`id\`)
    ON DELETE SET NULL`,
);

// Step 3: add connectionId column to target_websites
await run(
  "3. ADD COLUMN target_websites.connectionId",
  `ALTER TABLE \`target_websites\`
    ADD COLUMN \`connectionId\` int NULL,
    ALGORITHM=INSTANT`,
);

// Step 4: add index on connectionId
await run(
  "4. ADD INDEX idx_target_websites_connection_id",
  `ALTER TABLE \`target_websites\`
    ADD KEY \`idx_target_websites_connection_id\` (\`connectionId\`)`,
);

// Step 5: add FK from target_websites.connectionId → connections.id
await run(
  "5. ADD FK fk_target_websites_connection",
  `ALTER TABLE \`target_websites\`
    ADD CONSTRAINT \`fk_target_websites_connection\`
    FOREIGN KEY (\`connectionId\`)
    REFERENCES \`connections\` (\`id\`)
    ON DELETE SET NULL`,
);

console.log("\n=== Migration 0043 applied successfully ===\n");
await c.end();
