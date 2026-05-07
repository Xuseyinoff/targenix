/**
 * filterEngine.ts — Pure condition evaluator for lead routing filters.
 *
 * No external deps, no eval, no side effects.
 * A FilterRule is stored in integrationDestinations.filterJson.
 * evaluateFilter(rule, lead) returns true = lead passes (should be delivered).
 */

export type FilterOperator =
  | "eq" | "neq"
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "exists" | "not_exists"
  | "in" | "not_in";

export interface FilterCondition {
  field: string;     // "phone", "email", "fullName", or any extraFields key
  operator: FilterOperator;
  value: string;     // "" for exists/not_exists
}

export interface FilterRule {
  enabled: boolean;
  logic: "AND" | "OR";
  conditions: FilterCondition[];
}

export interface FilterLeadPayload {
  fullName: string | null;
  phone: string | null;
  email: string | null;
  pageId: string;
  formId: string;
  extraFields: Record<string, unknown>;
}

// ─── Field resolution ─────────────────────────────────────────────────────────

function getFieldValue(field: string, lead: FilterLeadPayload): string | null {
  switch (field) {
    case "phone":    return lead.phone;
    case "email":    return lead.email;
    case "fullName": return lead.fullName;
    case "pageId":   return lead.pageId;
    case "formId":   return lead.formId;
    default: {
      const v = lead.extraFields[field];
      return v != null ? String(v) : null;
    }
  }
}

// ─── Operator evaluation ──────────────────────────────────────────────────────

function applyOperator(
  op: FilterOperator,
  fieldValue: string | null,
  condValue: string,
): boolean {
  const isEmpty = fieldValue === null || fieldValue === "";

  if (op === "exists")     return !isEmpty;
  if (op === "not_exists") return isEmpty;

  const fv = (fieldValue ?? "").toLowerCase().trim();
  const cv = condValue.toLowerCase().trim();

  switch (op) {
    case "eq":           return fv === cv;
    case "neq":          return fv !== cv;
    case "contains":     return fv.includes(cv);
    case "not_contains": return !fv.includes(cv);
    case "starts_with":  return fv.startsWith(cv);
    case "ends_with":    return fv.endsWith(cv);
    case "gt":  { const n = parseFloat(fv); return !isNaN(n) && n >  parseFloat(cv); }
    case "gte": { const n = parseFloat(fv); return !isNaN(n) && n >= parseFloat(cv); }
    case "lt":  { const n = parseFloat(fv); return !isNaN(n) && n <  parseFloat(cv); }
    case "lte": { const n = parseFloat(fv); return !isNaN(n) && n <= parseFloat(cv); }
    case "in":
      return cv.split(",").map((s) => s.trim()).includes(fv);
    case "not_in":
      return !cv.split(",").map((s) => s.trim()).includes(fv);
    default:
      return false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a filter rule against a lead.
 *
 * Returns true if the lead should be delivered (passes the filter).
 * Always returns true when:
 *  - filter.enabled is false
 *  - filter.conditions is empty
 *  - rule is null / malformed
 */
export function evaluateFilter(
  filter: FilterRule | null | undefined,
  lead: FilterLeadPayload,
): boolean {
  if (!filter || !filter.enabled) return true;
  if (!Array.isArray(filter.conditions) || filter.conditions.length === 0) return true;

  const results = filter.conditions.map((cond) => {
    if (!cond?.field || !cond?.operator) return true; // malformed → pass
    const fieldValue = getFieldValue(cond.field, lead);
    return applyOperator(cond.operator, fieldValue, cond.value ?? "");
  });

  return filter.logic === "AND"
    ? results.every(Boolean)
    : results.some(Boolean);
}

/** Validate that a plain object looks like a FilterRule (for tRPC input safety). */
export function isFilterRule(x: unknown): x is FilterRule {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r.enabled !== "boolean") return false;
  if (r.logic !== "AND" && r.logic !== "OR") return false;
  if (!Array.isArray(r.conditions)) return false;
  return true;
}
