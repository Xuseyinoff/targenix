/**
 * Read-only: compare Sotuvchi-related target_websites for userId=1
 * (legacy custom vs admin template + connection).
 *
 *   railway run --service targenix.uz node tooling/mysql/_compare-sotuvchi-user1.mjs
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

function summarizeTemplateConfig(cfg) {
  if (cfg == null) return { raw: null };
  const o = typeof cfg === "string" ? JSON.parse(cfg) : cfg;
  if (!o || typeof o !== "object") return { raw: typeof cfg };
  const secrets = o.secrets;
  const secretKeys =
    secrets && typeof secrets === "object" && !Array.isArray(secrets)
      ? Object.keys(secrets)
      : [];
  return {
    keysTopLevel: Object.keys(o),
    secretKeys,
    method: o.method ?? null,
    contentType: o.contentType ?? null,
    variableFields: o.variableFields ?? null,
    bodyFieldsCount: Array.isArray(o.bodyFields) ? o.bodyFields.length : 0,
    bodyFieldKeys: Array.isArray(o.bodyFields)
      ? o.bodyFields.map((r) => r?.key).filter(Boolean)
      : [],
    hasBodyTemplate: typeof o.bodyTemplate === "string" && o.bodyTemplate.length > 0,
  };
}

function summarizeConnectionRow(cj) {
  if (!cj) return null;
  const o = typeof cj === "string" ? JSON.parse(cj) : cj;
  const se = o.secretsEncrypted;
  const keys =
    se && typeof se === "object" && !Array.isArray(se) ? Object.keys(se) : [];
  return {
    templateIdInCreds: o.templateId ?? null,
    secretsEncryptedKeys: keys,
    hasSecrets: keys.length > 0,
  };
}

async function main() {
  const url = getMysqlUrl();
  if (!url) {
    console.error("No MYSQL url");
    process.exit(1);
  }
  const conn = await mysql.createConnection({ uri: url });
  try {
    const [twRows] = await conn.query(
      `
      SELECT id, name, url, templateId, connectionId, templateType, templateConfig, isActive
        FROM target_websites
       WHERE userId = 1
         AND (
           LOWER(COALESCE(name, '')) LIKE '%sotuvchi%'
           OR LOWER(COALESCE(url, '')) LIKE '%sotuvchi%'
           OR templateId = 3
         )
       ORDER BY id ASC
      `,
    );

    const [tplRows] = await conn.query(
      `
      SELECT id, name, appKey, endpointUrl, method, contentType,
             bodyFields, userVisibleFields, variableFields
        FROM destination_templates
       WHERE isActive = 1
         AND (LOWER(appKey) = 'sotuvchi' OR LOWER(name) LIKE '%sotuvchi%')
       ORDER BY id ASC
      `,
    );

    function tplBodySummary(tpl) {
      if (!tpl?.bodyFields) return null;
      const bf =
        typeof tpl.bodyFields === "string"
          ? JSON.parse(tpl.bodyFields)
          : tpl.bodyFields;
      if (!Array.isArray(bf)) return null;
      return {
        count: bf.length,
        keys: bf.map((x) => x?.key).filter(Boolean),
        userVisibleFields: tpl.userVisibleFields,
        variableFields: tpl.variableFields,
      };
    }

    const out = {
      destinationTemplates_sotuvchi: tplRows.map((t) => ({
        ...t,
        bodySummary: tplBodySummary(t),
      })),
      targetWebsites_user1: [],
    };

    for (const r of twRows) {
      const cfgSum = summarizeTemplateConfig(r.templateConfig);
      let connSum = null;
      if (r.connectionId) {
        const [[c]] = await conn.query(
          `SELECT id, type, appKey, displayName, status, credentialsJson FROM connections WHERE id = ? LIMIT 1`,
          [r.connectionId],
        );
        if (c) {
          connSum = {
            id: c.id,
            type: c.type,
            appKey: c.appKey,
            displayName: c.displayName,
            status: c.status,
            credentialsSummary: summarizeConnectionRow(c.credentialsJson),
          };
        }
      }
      let tplMeta = null;
      if (r.templateId) {
        const [[t]] = await conn.query(
          `SELECT id, name, appKey, endpointUrl FROM destination_templates WHERE id = ? LIMIT 1`,
          [r.templateId],
        );
        if (t) tplMeta = t;
      }
      out.targetWebsites_user1.push({
        id: r.id,
        name: r.name,
        url: r.url,
        templateId: r.templateId,
        connectionId: r.connectionId,
        templateType: r.templateType,
        isActive: r.isActive,
        templateConfigSummary: cfgSum,
        linkedTemplate: tplMeta,
        linkedConnection: connSum,
      });
    }

    const [connSot] = await conn.query(
      `
      SELECT id, userId, type, appKey, displayName, status,
             JSON_UNQUOTE(JSON_EXTRACT(credentialsJson, '$.templateId')) AS credTemplateId
        FROM connections
       WHERE userId = 1
         AND (
           appKey = 'sotuvchi'
           OR JSON_UNQUOTE(JSON_EXTRACT(credentialsJson, '$.templateId')) = '3'
         )
       ORDER BY id ASC
      `,
    );
    out.connections_user1_sotuvchi_or_tpl3 = connSot;

    const [twTpl3] = await conn.query(
      `
      SELECT id, name, url, templateId, connectionId, templateType
        FROM target_websites
       WHERE userId = 1
         AND templateId = 3
       ORDER BY id ASC
      `,
    );
    out.targetWebsites_user1_templateId_3 = twTpl3;

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
