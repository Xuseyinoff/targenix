import type { LeadPayload } from "../services/affiliateService";

/**
 * Resolve a simple mapping object into a concrete payload.
 *
 * Supported placeholders:
 *   "{{lead.fullName}}", "{{lead.phone}}", "{{lead.email}}", "{{lead.leadgenId}}", "{{lead.pageId}}", "{{lead.formId}}"
 *   "{{lead.extraFields.some_key}}"
 *
 * Any other string is returned as-is.
 */
export function resolveMapping(
  mapping: Record<string, unknown> | null | undefined,
  lead: LeadPayload,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!mapping || typeof mapping !== "object") return out;

  for (const [key, rawVal] of Object.entries(mapping)) {
    if (typeof rawVal !== "string") {
      out[key] = rawVal;
      continue;
    }
    const v = rawVal.trim();
    const m = v.match(/^\{\{\s*lead\.([a-zA-Z0-9_]+)(?:\.([a-zA-Z0-9_:-]+))?\s*\}\}$/);
    if (!m) {
      out[key] = rawVal;
      continue;
    }
    const field = m[1];
    const sub = m[2];
    if (field === "extraFields" && sub) {
      out[key] = lead.extraFields?.[sub] ?? "";
      continue;
    }
    out[key] = (lead as unknown as Record<string, unknown>)[field] ?? "";
  }

  return out;
}

