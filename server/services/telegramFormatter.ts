/**
 * telegramFormatter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Universal, provider-agnostic Telegram HTML message formatter for lead
 * notifications.  Works with ANY third-party integration (affiliate platforms,
 * CRM systems, custom APIs) without hardcoding provider names or response
 * shapes.
 *
 * parse_mode = HTML  (Telegram Bot API)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LeadContext {
  /** Lead owner's full name (from Facebook form) */
  fullName: string | null;
  /** Lead owner's phone number */
  phone: string | null;
  /** Facebook account display name (e.g. "Xusenova Sitoramo") */
  accountName?: string | null;
  /** Facebook page name (e.g. "Go'zallik Mo'jizasi") */
  pageName?: string | null;
  /** Facebook lead form name (e.g. "Tibbiyot Form - 7") */
  formName?: string | null;
}

export interface RoutingContext {
  /** Human-readable integration / routing rule name */
  integrationName: string;
  /** Target website / platform name (e.g. "Sotuvchi.com") — shown after Yo'naltirildi */
  targetWebsiteName?: string | null;
  /** Whether the delivery to the target API succeeded */
  success: boolean;
  /** Raw API response body (any shape) */
  responseData?: unknown;
  /** Error message when success = false */
  error?: string;
  /** Round-trip time in milliseconds */
  durationMs?: number;
}

export interface FormatLeadMessageOptions {
  lead: LeadContext;
  routing: RoutingContext;
  /** When true, adds a [TEST] badge to the header */
  isTest?: boolean;
  /** When true, adds a [ADMIN] badge to the header (admin-triggered backfill) */
  isAdmin?: boolean;
  /** When true, adds a [RETRY] badge (timed order auto-retry, not initial webhook delivery) */
  isAutoRetry?: boolean;
  /** Shown in the status block when {@link isAutoRetry} — 1-based attempt index / max tries */
  deliveryAttempt?: { current: number; max: number };
}

// ─── HTML escaping ────────────────────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escVal(val: unknown): string {
  return esc(String(val ?? ""));
}

// ─── Smart response parser ────────────────────────────────────────────────────

interface ParsedResponse {
  statusEmoji: string;
  statusLabel: string;
  fields: Array<{ label: string; value: string }>;
}

/**
 * Intelligently extracts meaningful fields from ANY API response object.
 * Never outputs raw JSON.  Limits output to 4–6 lines.
 */
export function parseApiResponse(
  integrationName: string,
  responseData: unknown,
  success: boolean,
  error?: string
): ParsedResponse {
  // ── Fallback for non-object responses ────────────────────────────────────
  if (responseData === null || responseData === undefined) {
    if (!success && error) {
      return {
        statusEmoji: "🔴",
        statusLabel: "Error",
        fields: [{ label: "Error", value: truncate(error, 120) }],
      };
    }
    return {
      statusEmoji: "⚪",
      statusLabel: "Unknown response format",
      fields: [],
    };
  }

  if (typeof responseData !== "object" || Array.isArray(responseData)) {
    // Primitive or array — show as-is but truncated
    const raw = truncate(JSON.stringify(responseData), 120);
    return {
      statusEmoji: success ? "🟢" : "🔴",
      statusLabel: success ? "Success" : "Error",
      fields: [{ label: "Response", value: raw }],
    };
  }

  const obj = responseData as Record<string, unknown>;

  // ── Status detection ──────────────────────────────────────────────────────
  const statusRaw = obj.status ?? obj.success ?? obj.ok ?? obj.result ?? obj.code;
  let statusEmoji: string;
  let statusLabel: string;

  if (statusRaw !== undefined) {
    const s = String(statusRaw).toLowerCase();
    if (
      s === "true" ||
      s === "1" ||
      s === "success" ||
      s === "ok" ||
      s === "200" ||
      s === "accepted"
    ) {
      statusEmoji = "🟢";
      statusLabel = "Success";
    } else if (
      s === "false" ||
      s === "0" ||
      s === "error" ||
      s === "fail" ||
      s === "failed" ||
      s === "rejected"
    ) {
      statusEmoji = "🔴";
      statusLabel = "Error";
    } else {
      statusEmoji = success ? "🟢" : "🔴";
      statusLabel = truncate(String(statusRaw), 40);
    }
  } else {
    statusEmoji = success ? "🟢" : "🔴";
    statusLabel = success ? "Success" : "Error";
  }

  // ── Field extraction (priority order) ────────────────────────────────────
  const fields: Array<{ label: string; value: string }> = [];

  // Message / description
  const msgVal = firstDefined(obj, [
    "message",
    "msg",
    "detail",
    "description",
    "error_message",
    "error",
    "reason",
    "text",
  ]);
  if (msgVal !== undefined && String(msgVal).trim()) {
    fields.push({ label: "Message", value: truncate(String(msgVal), 120) });
  }

  // Order / lead / request ID
  const idVal = firstDefined(obj, [
    "order_id",
    "orderId",
    "lead_id",
    "leadId",
    "request_id",
    "requestId",
    "id",
    "ref",
    "reference",
    "transaction_id",
    "transactionId",
  ]);
  if (idVal !== undefined && String(idVal).trim()) {
    fields.push({ label: "ID", value: truncate(String(idVal), 80) });
  }

  // Price / payout
  const priceVal = firstDefined(obj, [
    "price",
    "amount",
    "payout",
    "reward",
    "commission",
    "sum",
  ]);
  if (priceVal !== undefined && String(priceVal).trim()) {
    fields.push({ label: "Amount", value: truncate(String(priceVal), 40) });
  }

  // Optional extras (status_text, comment, response_code)
  const extras: Array<[string, string]> = [
    ["Status text", "status_text"],
    ["Comment", "comment"],
    ["Code", "response_code"],
    ["Code", "code"],
    ["Stream", "stream"],
    ["Offer", "offer_id"],
  ];
  for (const [label, key] of extras) {
    if (fields.length >= 5) break; // cap at 5 extra fields
    const v = obj[key];
    if (v !== undefined && String(v).trim() && !fields.some((f) => f.label === label)) {
      fields.push({ label, value: truncate(String(v), 80) });
    }
  }

  // If nothing useful was extracted, show unknown
  if (fields.length === 0 && statusLabel === "Success") {
    // No extra info needed — success with no body details is fine
  } else if (fields.length === 0) {
    return {
      statusEmoji: "⚪",
      statusLabel: "Unknown response format",
      fields: [],
    };
  }

  return { statusEmoji, statusLabel, fields };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function firstDefined(
  obj: Record<string, unknown>,
  keys: string[]
): unknown | undefined {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

// ─── Main formatter ───────────────────────────────────────────────────────────

/**
 * Build a compact Telegram HTML message for delivery-chat lead notifications.
 *
 * @example
 * const html = formatLeadMessage({
 *   lead: { fullName: "Ali Valiyev", phone: "+998901234567", pageName: "My Page", ... },
 *   routing: { integrationName: "CRM-X", success: true, responseData: {...}, durationMs: 320 },
 * });
 * await bot.sendMessage(chatId, html, { parse_mode: "HTML" });
 */
export function formatLeadMessage(opts: FormatLeadMessageOptions): string {
  const { lead, routing, isTest = false, isAdmin = false, isAutoRetry = false, deliveryAttempt } = opts;

  const name = esc(lead.fullName?.trim() || "—");
  const phone = esc(lead.phone?.trim() || "—");
  const accountName = lead.accountName ? esc(lead.accountName.trim()) : null;
  const pageName = lead.pageName ? esc(lead.pageName.trim()) : null;
  const formName = lead.formName ? esc(lead.formName.trim()) : null;
  const integrationName = esc(routing.integrationName.trim());

  // Response time
  const responseTime =
    routing.durationMs !== undefined
      ? `${(routing.durationMs / 1000).toFixed(2)}s`
      : "—";

  // Parse API response
  const parsed = parseApiResponse(
    routing.integrationName,
    routing.responseData,
    routing.success,
    routing.error
  );

  // ── 1. HEADER (minimal delivery template) ─────────────────────────────────
  const parts: string[] = [];
  const headerBadges: string[] = [];
  if (isTest) headerBadges.push(`[TEST]`);
  if (isAdmin) headerBadges.push(`[ADMIN]`);
  if (isAutoRetry) headerBadges.push(`[RETRY]`);
  const headerSuffix = headerBadges.length ? ` ${headerBadges.join(" ")}` : "";
  parts.push(`🚀 <b>NEW LEAD</b>${headerSuffix}`);

  // ── 2. CLIENT BLOCK (blockquote #1) ───────────────────────────────────────
  const nameDisplay = lead.fullName?.trim() ? `<b>${name}</b>` : name;
  parts.push(`<blockquote>👤 ${nameDisplay}\n📞 <code>${phone}</code></blockquote>`);

  // ── 3. SOURCE (compact, no "SOURCE" heading) ─────────────────────────────
  const sourceLines: string[] = [];
  if (accountName) sourceLines.push(`📌 Account: ${accountName}`);
  if (pageName) sourceLines.push(`📍 Sahifa: ${pageName}`);
  if (formName) sourceLines.push(`📝 Forma: ${formName}`);
  if (sourceLines.length) parts.push(sourceLines.join("\n"));

  // ── 4. ROUTING (single line — destination only, no duplicate page) ─────────
  const targetName = routing.targetWebsiteName
    ? esc(routing.targetWebsiteName.trim())
    : integrationName;
  parts.push(`🔀 Yo'naltirildi → ${targetName}`);

  // ── 5. RETRY + DELIVERY LINE ───────────────────────────────────────────────
  const midLines: string[] = [];
  if (
    isAutoRetry &&
    deliveryAttempt &&
    deliveryAttempt.current >= 1 &&
    deliveryAttempt.max >= 1
  ) {
    const cur = Math.min(deliveryAttempt.current, deliveryAttempt.max);
    const max = deliveryAttempt.max;
    midLines.push(`🔁 Urinish: ${cur}/${max}`);
  }
  const deliveryLine =
    routing.success
      ? routing.durationMs !== undefined
        ? `✅ Yuborildi • ${responseTime}`
        : `✅ Yuborildi`
      : routing.durationMs !== undefined
        ? `❌ Yuborilmadi • ${responseTime}`
        : `❌ Yuborilmadi`;
  midLines.push(deliveryLine);
  parts.push(midLines.join("\n"));

  // ── 6. RESPONSE (single blockquote; no outer "→ RESPONSE" header) ───────────
  const rawStatusLabel =
    parsed.statusLabel === "Success"
      ? "SUCCESS"
      : parsed.statusLabel === "Error"
        ? "FAILED"
        : parsed.statusLabel;
  const statusBold = `<b>${parsed.statusEmoji} ${esc(rawStatusLabel)}</b>`;

  const idField = parsed.fields.find((f) => f.label === "ID");
  const msgField = parsed.fields.find((f) => f.label === "Message");
  const extraFields = parsed.fields.filter((f) => f.label !== "ID" && f.label !== "Message");

  const responseBodyLines: string[] = [statusBold];
  if (idField) responseBodyLines.push(`ID: <code>${esc(idField.value)}</code>`);
  if (msgField) responseBodyLines.push(`Xabar: ${esc(msgField.value)}`);
  for (const f of extraFields) {
    responseBodyLines.push(`${esc(f.label)}: ${esc(f.value)}`);
  }

  parts.push(`<blockquote>${responseBodyLines.join("\n")}</blockquote>`);

  return parts.join("\n\n");
}
