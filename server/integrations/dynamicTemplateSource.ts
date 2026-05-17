/**
 * Stage 2 — dual-read: prefer `app_actions` (mirror) when present, else
 * `destination_templates` (authoritative for writes and IDs).
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { appActions, apps, destinationTemplates } from "../../drizzle/schema";
import type { AppActionRow, DestinationTemplate } from "../../drizzle/schema";
import type { destinations } from "../../drizzle/schema";
import type { DbClient } from "../db";

/**
 * Legacy mirror keys were `t${templateId}`. For the first few built-in affiliate
 * templates we migrated to semantic keys in `app_actions.actionKey`, but we must
 * stay backward compatible with existing DB contents.
 */
const LEGACY_TO_SEMANTIC: Record<string, string> = {
  t1: "send_lead",
  t2: "append_row",
  t3: "send_message",
  t4: "create_contact",
  t5: "update_deal",
};

function actionKeysForTemplateId(tid: number): string[] {
  const legacy = `t${tid}`;
  const semantic = LEGACY_TO_SEMANTIC[legacy];
  return semantic ? [semantic, legacy] : [legacy];
}

function resolveOverlayAction(
  byKey: Map<string, AppActionRow>,
  appKey: string,
  templateId: number,
): AppActionRow | null {
  for (const k of actionKeysForTemplateId(templateId)) {
    const a = byKey.get(`${appKey}::${k}`);
    if (a) return a;
  }
  return null;
}

/**
 * Synthesize a `DestinationTemplate` row for delivery/preview. `id` remains
 * `destination_templates.id` (secret resolution, templateId contract).
 */
export function appActionToDestinationTemplate(
  a: AppActionRow,
  templateId: number,
): DestinationTemplate {
  return {
    id: templateId,
    name: a.name,
    description: null,
    color: "#3B82F6",
    category: "affiliate",
    appKey: a.appKey,
    endpointUrl: a.endpointUrl,
    method: a.method,
    contentType: a.contentType ?? "application/x-www-form-urlencoded",
    bodyFields: a.bodyFields,
    userVisibleFields: a.userFields,
    variableFields: a.variableFields,
    autoMappedFields: a.autoMappedFields,
    isActive: a.isActive,
    createdAt: a.createdAt,
  };
}

/**
 * By `destinations.actionId` (preferred), else `destination_templates`.
 */
export async function loadDynamicExecutionTemplate(
  db: DbClient,
  tw: typeof destinations.$inferSelect,
): Promise<{ template: DestinationTemplate; source: "app_actions" | "destination_templates" } | null> {
  if (tw.templateId == null) return null;

  if (tw.actionId != null) {
    const [a] = await db
      .select()
      .from(appActions)
      .where(eq(appActions.id, tw.actionId))
      .limit(1);
    if (a) {
      return { template: appActionToDestinationTemplate(a, tw.templateId), source: "app_actions" };
    }
  }

  const [dt] = await db
    .select()
    .from(destinationTemplates)
    .where(eq(destinationTemplates.id, tw.templateId))
    .limit(1);
  if (!dt) return null;
  return { template: dt, source: "destination_templates" };
}

/**
 * `app_actions.id` for 0048 mirror row (`actionKey` = `t` + template id).
 */
export async function findAppActionIdForTemplate(
  db: DbClient,
  templateId: number,
  appKey: string | null | undefined,
): Promise<number | null> {
  if (appKey == null || String(appKey).trim() === "") return null;
  const aks = actionKeysForTemplateId(templateId);
  const [r] = await db
    .select({ id: appActions.id })
    .from(appActions)
    .where(and(eq(appActions.appKey, appKey), inArray(appActions.actionKey, aks)))
    .limit(1);
  return r?.id ?? null;
}

/**
 * All `destination_templates` rows, overlay body/name/url from `app_actions` when
 * the 0048 pair (`appKey`, `t`+id) exists.
 */
export async function listDestinationTemplatesWithMirrorOverlay(
  db: DbClient,
): Promise<DestinationTemplateForPicker[]> {
  const dtRows = await db
    .select()
    .from(destinationTemplates)
    .orderBy(desc(destinationTemplates.createdAt));
  if (dtRows.length === 0) return [];

  // Build (appKey → iconUrl) map in one query so the response carries the
  // brand mark without forcing every consumer to re-query the apps table.
  const allKeys = Array.from(
    new Set(dtRows.map((d) => d.appKey).filter((k): k is string => !!k && k.trim() !== "")),
  );
  const iconByAppKey = new Map<string, string>();
  if (allKeys.length > 0) {
    const appRows = await db
      .select({ appKey: apps.appKey, iconUrl: apps.iconUrl })
      .from(apps)
      .where(inArray(apps.appKey, allKeys));
    for (const r of appRows) {
      if (r.iconUrl) iconByAppKey.set(r.appKey, r.iconUrl);
    }
  }

  const withKeys = dtRows.filter((d) => d.appKey && String(d.appKey).trim() !== "");
  if (withKeys.length === 0) {
    return dtRows.map((dt) => ({
      ...dt,
      appIconUrl: dt.appKey ? (iconByAppKey.get(dt.appKey) ?? null) : null,
    }));
  }

  const pairConds = withKeys.map((d) => {
    const aks = actionKeysForTemplateId(d.id);
    return and(eq(appActions.appKey, d.appKey!), inArray(appActions.actionKey, aks));
  });
  const orPred = pairConds.length === 1 ? pairConds[0]! : or(...pairConds);

  const aaRows = await db
    .select()
    .from(appActions)
    .where(orPred);

  const byKey = new Map<string, AppActionRow>();
  for (const a of aaRows) {
    byKey.set(`${a.appKey}::${a.actionKey}`, a);
  }

  return dtRows.map((dt) => {
    const appIconUrl = dt.appKey ? (iconByAppKey.get(dt.appKey) ?? null) : null;
    if (!dt.appKey) return { ...dt, appIconUrl };
    const a = resolveOverlayAction(byKey, dt.appKey, dt.id);
    if (!a) {
      return { ...dt, appIconUrl };
    }
    return {
      ...dt,
      name: a.name,
      endpointUrl: a.endpointUrl,
      appKey: a.appKey,
      method: a.method,
      contentType: a.contentType ?? dt.contentType,
      bodyFields: a.bodyFields,
      userVisibleFields: a.userFields,
      variableFields: a.variableFields,
      autoMappedFields: a.autoMappedFields,
      appIconUrl,
    };
  });
}

/**
 * Same shape as `DestinationTemplate` with the app row's icon URL spliced in
 * so the client can render the brand mark without re-querying. `null` when
 * the template's `appKey` has no matching `apps` row or the row's `iconUrl`
 * is unset — the client falls back to the legacy hardcoded map and then to
 * the generic Globe placeholder.
 */
export type DestinationTemplateForPicker = DestinationTemplate & {
  appIconUrl: string | null;
};

export async function listActiveDestinationTemplatesForPicker(
  db: DbClient,
): Promise<DestinationTemplateForPicker[]> {
  // `listDestinationTemplatesWithMirrorOverlay` already joins `apps.iconUrl`,
  // so we just filter for active rows and sort by name.
  const merged = await listDestinationTemplatesWithMirrorOverlay(db);
  return merged
    .filter((t) => t.isActive)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/**
 * Legacy sotuvchi/100k row: prefer mirrored `app_actions` endpoint, else
 * `destination_templates`.
 */
/**
 * Same overlay as list, but only for `ids` (for destinations.list enrichment).
 */
export async function fetchDestinationTemplatesWithOverlayByIds(
  db: DbClient,
  ids: number[],
): Promise<Map<number, DestinationTemplate>> {
  const out = new Map<number, DestinationTemplate>();
  if (ids.length === 0) return out;

  const dtRows = await db
    .select()
    .from(destinationTemplates)
    .where(inArray(destinationTemplates.id, ids));
  for (const dt of dtRows) {
    out.set(dt.id, dt);
  }

  const withKeys = dtRows.filter((d) => d.appKey && String(d.appKey).trim() !== "");
  if (withKeys.length === 0) return out;

  const pairConds = withKeys.map((d) => {
    const aks = actionKeysForTemplateId(d.id);
    return and(eq(appActions.appKey, d.appKey!), inArray(appActions.actionKey, aks));
  });
  const orPred = pairConds.length === 1 ? pairConds[0]! : or(...pairConds);
  const aaRows = await db
    .select()
    .from(appActions)
    .where(orPred);

  const byKey = new Map<string, AppActionRow>();
  for (const a of aaRows) {
    byKey.set(`${a.appKey}::${a.actionKey}`, a);
  }

  for (const dt of withKeys) {
    const a = resolveOverlayAction(byKey, dt.appKey!, dt.id);
    if (!a) continue;
    out.set(dt.id, {
      ...dt,
      name: a.name,
      endpointUrl: a.endpointUrl,
      appKey: a.appKey,
      method: a.method,
      contentType: a.contentType ?? dt.contentType,
      bodyFields: a.bodyFields,
      userVisibleFields: a.userFields,
      variableFields: a.variableFields,
      autoMappedFields: a.autoMappedFields,
    });
  }
  return out;
}

/** Denormalized `destinations.url` on create — match delivery (`app_actions` first). */
export async function preferAppActionEndpointUrl(
  db: DbClient,
  templateEndpoint: string,
  actionId: number | null,
): Promise<string> {
  if (actionId == null) return templateEndpoint;
  const [a] = await db
    .select({ endpointUrl: appActions.endpointUrl })
    .from(appActions)
    .where(eq(appActions.id, actionId))
    .limit(1);
  const ep = a?.endpointUrl;
  if (ep != null && typeof ep === "string" && ep.trim() !== "") return ep.trim();
  return templateEndpoint;
}

export async function getEndpointUrlByTemplateAppKey(
  db: DbClient,
  templateAppKey: string,
): Promise<string | null> {
  const [dt] = await db
    .select()
    .from(destinationTemplates)
    .where(eq(destinationTemplates.appKey, templateAppKey))
    .limit(1);
  if (!dt?.endpointUrl) return null;
  const aid = await findAppActionIdForTemplate(db, dt.id, dt.appKey ?? templateAppKey);
  if (aid == null) return dt.endpointUrl;
  const [a] = await db
    .select({ endpointUrl: appActions.endpointUrl })
    .from(appActions)
    .where(eq(appActions.id, aid))
    .limit(1);
  return (a?.endpointUrl ?? dt.endpointUrl) || null;
}
