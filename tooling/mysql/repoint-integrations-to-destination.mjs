/**
 * LEAD_ROUTING integratsiyalarni eski `target_websites.id` dan yangisiga
 * o‘tkazish: `config.targetWebsiteId`, `integrations.targetWebsiteId`,
 * `integration_destinations` (agar eski `from` u yerda bo‘lsa).
 *
 * Inbaza (connection) manzilini avtomatik topish:
 *   --to-connection-inbaza  +  --user-id=1
 *   → bitta foydalanuvchi uchun `connectionId IS NOT NULL` va url/name da
 *     inbaza bo‘lgan `target_websites` (agar bittadan ko‘p bo‘lsa, xato).
 *
 * Namuna (aniq id lar):
 *   --dry-run --user-id=1 --from=60002 --to=NEWTW --ids=240009,300003
 *   --apply --confirm=REPOINT --user-id=1 --from=60002 --to=NEWTW --ids=240009,300003
 *
 * Railway:
 *   railway run --service targenix.uz node tooling/mysql/repoint-integrations-to-destination.mjs --dry-run ...
 */

import "dotenv/config";
import mysql from "mysql2/promise";

function getMysqlUrl() {
  return (
    process.env.MYSQL_PUBLIC_URL ||
    process.env.MYSQL_URL ||
    process.env.DATABASE_URL
  );
}

function isInbazaTw(t) {
  const u = (t?.url ?? "").toLowerCase();
  const n = (t?.name ?? "").toLowerCase();
  return u.includes("inbaza") || n.includes("inbaza");
}

function parseArgs(argv) {
  const o = {
    dryRun: false,
    apply: false,
    userId: null,
    from: null,
    to: null,
    toConnectionInbaza: false,
    ids: null,
    confirm: null,
    requireConnection: true,
  };
  for (const a of argv) {
    if (a === "--dry-run") o.dryRun = true;
    if (a === "--apply") o.apply = true;
    if (a === "--to-connection-inbaza") o.toConnectionInbaza = true;
    if (a === "--allow-dest-without-connection") o.requireConnection = false;
    if (a.startsWith("--user-id="))
      o.userId = parseInt(a.slice("--user-id=".length), 10);
    if (a.startsWith("--from=")) o.from = parseInt(a.slice("--from=".length), 10);
    if (a.startsWith("--to=") && a.length > 5) {
      const v = parseInt(a.slice(5), 10);
      if (Number.isFinite(v) && v > 0) o.to = v;
    }
    if (a.startsWith("--ids="))
      o.ids = a
        .slice(6)
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    if (a.startsWith("--confirm=")) o.confirm = a.slice(10);
  }
  return o;
}

function extractTwIdFromConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const raw = cfg.targetWebsiteId;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if ((!args.dryRun && !args.apply) || (args.dryRun && args.apply)) {
    console.error("Aniq bittasini bering: --dry-run yoki --apply");
    process.exit(1);
  }
  if (args.apply && args.confirm !== "REPOINT") {
    console.error("Apply uchun: --confirm=REPOINT");
    process.exit(1);
  }
  if (!args.userId || !args.from) {
    console.error("Kerak: --user-id=... --from=<eski target_websites.id>");
    process.exit(1);
  }
  if (args.toConnectionInbaza && args.to) {
    console.error("--to=... va --to-connection-inbaza bir vaqtda emas");
    process.exit(1);
  }
  if (!args.toConnectionInbaza && (args.to == null || !Number.isFinite(args.to))) {
    console.error("Yoki --to=<yangi id> yoki --to-connection-inbaza bering");
    process.exit(1);
  }

  const url = getMysqlUrl();
  if (!url) {
    console.error("MYSQL url yo‘q");
    process.exit(1);
  }

  const conn = await mysql.createConnection({ uri: url });
  try {
    const [[fromTw]] = await conn.query(
      `SELECT id, userId, name, url, templateId, connectionId, templateConfig
         FROM target_websites
        WHERE id = ?
        LIMIT 1`,
      [args.from],
    );
    if (!fromTw) {
      console.error(`--from=${args.from} topilmadi`);
      process.exit(1);
    }
    if (fromTw.userId !== args.userId) {
      console.error(
        `--from userId=${fromTw.userId} siz kiritgan --user-id=${args.userId} ga mos emas`,
      );
      process.exit(1);
    }

    let toId = args.to;
    if (args.toConnectionInbaza) {
      const [cands] = await conn.query(
        `SELECT id, name, url, connectionId, templateId
           FROM target_websites
          WHERE userId = ? AND connectionId IS NOT NULL`,
        [args.userId],
      );
      const inbaza = cands.filter(isInbazaTw);
      if (inbaza.length === 0) {
        console.error(
          "Hech qanday Inbaza+connection (connectionId to‘ldirilgan) manzil topilmadi",
        );
        process.exit(1);
      }
      if (inbaza.length > 1) {
        console.error("Bir nechta Inbaza+connection manzillar; qaysi id ni tanlash aniq emas:");
        for (const r of inbaza) {
          console.error(
            `  id=${r.id} name=${r.name} url=${r.url} connectionId=${r.connectionId}`,
          );
        }
        process.exit(1);
      }
      toId = inbaza[0].id;
      console.log(
        `--to-connection-inbaza → target_websites.id=${toId} (${inbaza[0].name})`,
      );
    }

    if (toId === args.from) {
      console.log("from === to, o‘zgarish yo‘q (integratsiyalar allaqachon shu manzilga).");
      process.exit(0);
    }

    const [[toTw]] = await conn.query(
      `SELECT id, userId, name, url, templateId, connectionId, templateConfig
         FROM target_websites
        WHERE id = ?
        LIMIT 1`,
      [toId],
    );
    if (!toTw) {
      console.error(`Yangi manzil id=${toId} topilmadi`);
      process.exit(1);
    }
    if (toTw.userId !== args.userId) {
      console.error(`Yangi manzilning userId=${toTw.userId} mos emas`);
      process.exit(1);
    }
    if (args.requireConnection && toTw.connectionId == null) {
      console.error(
        "Yangi manzilda connectionId NULL. Connection yo‘lidan foydalanish uchun to‘g‘ri manzilni tanlang yoki --allow-dest-without-connection bering (tavsiya etilmaydi).",
      );
      process.exit(1);
    }

    const idFilter = args.ids?.length
      ? `AND id IN (${args.ids.map(() => "?").join(",")})`
      : "";
    const intParams = args.ids?.length ? [args.userId, ...args.ids] : [args.userId];
    const [integrRows] = await conn.query(
      `SELECT id, userId, type, name, targetWebsiteId, config
         FROM integrations
        WHERE userId = ? AND type = 'LEAD_ROUTING' ${idFilter}`,
      intParams,
    );

    const toPatch = [];
    for (const row of integrRows) {
      let cfg0;
      try {
        cfg0 = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
      } catch {
        console.warn(
          `integration id=${row.id} config parse xatosi, o‘tib ketildi`,
        );
        continue;
      }
      const fromCfg = extractTwIdFromConfig(
        typeof cfg0 === "object" && cfg0 != null ? cfg0 : null,
      );
      const fromCol = row.targetWebsiteId;
      const [destN] = await conn.query(
        `SELECT id, targetWebsiteId, position, enabled
           FROM integration_destinations
          WHERE integrationId = ? AND targetWebsiteId = ?`,
        [row.id, args.from],
      );

      const touchesFrom =
        fromCol === args.from || fromCfg === args.from || destN.length > 0;
      if (!touchesFrom) continue;

      toPatch.push({ row, cfg0, fromCfg, destRows: destN });
    }

    if (toPatch.length === 0) {
      console.log("Hech qanday integratsiya bu --from= bilan mos kelmadi yoki ids bo‘sh.");
      process.exit(0);
    }

    for (const p of toPatch) {
      const summary = {
        id: p.row.id,
        name: p.row.name,
        from_col: p.row.targetWebsiteId,
        from_config: extractTwIdFromConfig(
          typeof p.cfg0 === "object" && p.cfg0 != null ? p.cfg0 : null,
        ),
        dest_rows: p.destRows.length,
      };
      console.log(">", JSON.stringify(summary));
    }

    if (args.dryRun) {
      console.log("\n[--dry-run] hech narsa yozilmadi. Apply uchun --apply --confirm=REPOINT");
      process.exit(0);
    }

    await conn.beginTransaction();
    try {
      for (const p of toPatch) {
        const intId = p.row.id;
        const base =
          typeof p.cfg0 === "object" && p.cfg0 != null && !Array.isArray(p.cfg0) ? p.cfg0 : {};
        const cfg = { ...base, targetWebsiteId: toId };
        const cfgJson = JSON.stringify(cfg);

        for (const d of p.destRows) {
          const [dup] = await conn.query(
            `SELECT id FROM integration_destinations
              WHERE integrationId = ? AND targetWebsiteId = ? AND id != ?`,
            [intId, toId, d.id],
          );
          if (dup.length > 0) {
            await conn.query(
              `DELETE FROM integration_destinations WHERE id = ?`,
              [d.id],
            );
          } else {
            await conn.query(
              `UPDATE integration_destinations SET targetWebsiteId = ? WHERE id = ?`,
              [toId, d.id],
            );
          }
        }

        if (p.destRows.length === 0) {
          const [existingTo] = await conn.query(
            `SELECT id FROM integration_destinations
              WHERE integrationId = ? AND targetWebsiteId = ?`,
            [intId, toId],
          );
          if (existingTo.length === 0) {
            await conn.query(
              `INSERT INTO integration_destinations
                (integrationId, targetWebsiteId, position, enabled, filterJson, createdAt, updatedAt)
               VALUES (?, ?, 0, 1, NULL, NOW(), NOW())`,
              [intId, toId],
            );
          }
        }

        await conn.query(
          `UPDATE integrations
              SET targetWebsiteId = ?,
                  config = ?
            WHERE id = ? AND userId = ?`,
          [toId, cfgJson, intId, args.userId],
        );
      }

      await conn.commit();
      console.log(
        `OK: ${toPatch.length} integratsiya ${args.from} → ${toId} (commit).`,
      );
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
