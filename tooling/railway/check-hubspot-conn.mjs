import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL?.trim() ||
  process.env.MYSQL_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!url) {
  console.error("No MySQL URL found (MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL).");
  process.exit(1);
}

const conn = await mysql.createConnection(url);
try {
  const [tokens] = await conn.query(
    "SELECT id,userId,appKey,email,name,createdAt,expiryDate FROM oauth_tokens WHERE appKey='hubspot' ORDER BY createdAt DESC LIMIT 20",
  );
  const [conns] = await conn.query(
    "SELECT id,userId,type,appKey,displayName,status,oauthTokenId,createdAt,lastVerifiedAt FROM connections WHERE appKey='hubspot' ORDER BY createdAt DESC LIMIT 20",
  );
  const [joined] = await conn.query(
    "SELECT ot.id AS oauthTokenId, ot.userId, ot.email, ot.createdAt, c.id AS connectionId, c.status AS connectionStatus FROM oauth_tokens ot LEFT JOIN connections c ON c.oauthTokenId=ot.id AND c.userId=ot.userId WHERE ot.appKey='hubspot' ORDER BY ot.createdAt DESC LIMIT 20",
  );
  const [counts] = await conn.query(
    "SELECT (SELECT COUNT(*) FROM oauth_tokens WHERE appKey='hubspot') AS tokens, (SELECT COUNT(*) FROM connections WHERE appKey='hubspot') AS connections",
  );

  console.log(
    JSON.stringify(
      {
        counts: counts?.[0] ?? counts,
        hubspotTokens: tokens,
        hubspotConnections: conns,
        tokenConnectionJoin: joined,
      },
      null,
      2,
    ),
  );
} finally {
  await conn.end();
}

