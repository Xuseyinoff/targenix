import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { log } from "./appLogger";

const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

/** Mask an access token for safe logging — show only first/last 6 chars */
function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

export interface LeadFieldData {
  name: string;
  values: string[];
}

export interface LeadData {
  id: string;
  created_time: string;
  field_data: LeadFieldData[];
  platform?: "fb" | "ig";
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
}

/**
 * Verify Facebook X-Hub-Signature-256 header.
 * Returns true if the signature matches.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader) {
    console.warn("[Facebook] Missing X-Hub-Signature-256 header");
    return false;
  }
  const [algo, digest] = signatureHeader.split("=");
  if (algo !== "sha256" || !digest) {
    console.warn("[Facebook] Unexpected signature format:", signatureHeader);
    return false;
  }
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  // Use constant-time comparison to prevent timing attacks that could allow
  // byte-by-byte brute-forcing of the HMAC value.
  let isValid = false;
  try {
    const expectedBuf = Buffer.from(expected, "hex");
    const digestBuf = Buffer.from(digest, "hex");
    isValid = expectedBuf.length === digestBuf.length && timingSafeEqual(expectedBuf, digestBuf);
  } catch {
    isValid = false;
  }
  if (!isValid) {
    console.warn("[Facebook] Signature mismatch — possible tampered request");
  }
  return isValid;
}

/**
 * Fetch full lead data from Facebook Graph API using the page access token.
 */
export async function fetchLeadData(
  leadgenId: string,
  accessToken: string
): Promise<LeadData | null> {
  const url = `${GRAPH_API_BASE}/${leadgenId}`;
  await log.info("FACEBOOK", `→ fetchLeadData(${leadgenId})`, {
    endpoint: `/${leadgenId}`,
    accessToken: maskToken(accessToken),
  });

  const startAt = Date.now();
  try {
    const response = await axios.get<LeadData>(url, {
      params: { access_token: accessToken, fields: "id,created_time,field_data,platform,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id" },
      timeout: 10000,
    });
    const duration = Date.now() - startAt;
    await log.info("FACEBOOK", `← fetchLeadData(${leadgenId}) → 200 (${duration}ms)`, {
      duration,
      fieldCount: response.data?.field_data?.length ?? 0,
      fields: response.data?.field_data?.map((f) => f.name),
    });
    return response.data;
  } catch (err: unknown) {
    const duration = Date.now() - startAt;
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    const fbError = (axiosErr?.response?.data as { error?: { message?: string; code?: number } })?.error;
    const message = fbError?.message ?? axiosErr?.message ?? "Unknown error";
    await log.error("FACEBOOK", `← fetchLeadData(${leadgenId}) → ERROR (${duration}ms): ${message}`, {
      duration,
      status: axiosErr?.response?.status,
      fbErrorCode: fbError?.code,
      fbErrorMessage: fbError?.message,
    });
    return null;
  }
}

export interface PollLeadItem {
  id: string;
  created_time: string;
  field_data: LeadFieldData[];
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
}

export interface PollLeadsResponse {
  data: PollLeadItem[];
  paging?: {
    cursors?: { before: string; after: string };
    next?: string;
  };
}

/**
 * Fetch all leads from a specific Facebook Lead Form via Graph API polling.
 * Supports pagination — fetches all pages automatically.
 */
export async function fetchLeadsFromForm(
  formId: string,
  accessToken: string,
  options: { limit?: number; after?: string; hoursBack?: number } = {}
): Promise<PollLeadItem[]> {
  const allLeads: PollLeadItem[] = [];
  let afterCursor: string | undefined = options.after;
  let page = 0;
  const maxPages = 10; // Safety cap to avoid infinite loops
  const hoursBack = options.hoursBack ?? null;
  const cutoff = hoursBack != null ? new Date(Date.now() - hoursBack * 60 * 60 * 1000) : null;

  await log.info("FACEBOOK", `→ fetchLeadsFromForm(${formId}) started`, {
    formId,
    accessToken: maskToken(accessToken),
    limit: options.limit ?? 100,
    hoursBack: hoursBack ?? undefined,
    cutoffIso: cutoff ? cutoff.toISOString() : undefined,
  });

  const totalStart = Date.now();

  do {
    try {
      const params: Record<string, string | number> = {
        access_token: accessToken,
        fields: "id,created_time,field_data,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id",
        limit: options.limit ?? 100,
      };
      if (afterCursor) params.after = afterCursor;

      const url = `${GRAPH_API_BASE}/${formId}/leads`;
      const startAt = Date.now();
      const response = await axios.get<PollLeadsResponse>(url, {
        params,
        timeout: 15000,
      });
      const duration = Date.now() - startAt;

      const rawBatch = response.data.data ?? [];
      // Best-effort: ensure newest→oldest within the batch (so cutoff stop is deterministic).
      const batch = rawBatch
        .slice()
        .sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());

      let included = 0;
      let stoppedByCutoff = false;
      for (const item of batch) {
        if (cutoff) {
          const t = new Date(item.created_time);
          if (Number.isFinite(t.getTime()) && t < cutoff) {
            stoppedByCutoff = true;
            break;
          }
        }
        allLeads.push(item);
        included++;
      }

      await log.info("FACEBOOK", `← fetchLeadsFromForm(${formId}) page ${page + 1}: +${included}/${batch.length} leads (${duration}ms)`, {
        formId,
        page: page + 1,
        batchSize: batch.length,
        included,
        totalSoFar: allLeads.length,
        duration,
        hasNext: !!response.data.paging?.next,
        stoppedByCutoff,
      });

      if (stoppedByCutoff) break;

      afterCursor = response.data.paging?.cursors?.after;
      const hasNext = !!response.data.paging?.next && batch.length > 0;
      if (!hasNext) break;
      page++;
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: unknown }; message?: string };
      const fbError = (axiosErr?.response?.data as { error?: { message?: string; code?: number } })?.error;
      const message = fbError?.message ?? axiosErr?.message ?? "Unknown error";
      await log.error("FACEBOOK", `← fetchLeadsFromForm(${formId}) page ${page + 1} ERROR: ${message}`, {
        formId,
        page: page + 1,
        fbErrorCode: fbError?.code,
        fbErrorMessage: fbError?.message,
      });
      break;
    }
  } while (page < maxPages);

  const totalDuration = Date.now() - totalStart;
  await log.info("FACEBOOK", `fetchLeadsFromForm(${formId}) complete: ${allLeads.length} leads total (${totalDuration}ms)`, {
    formId,
    totalLeads: allLeads.length,
    pages: page + 1,
    totalDuration,
    hoursBack: hoursBack ?? undefined,
  });

  return allLeads;
}

/**
 * Validate a Page Access Token by calling the Graph API.
 * Returns true if the token is valid and belongs to the given page.
 */
export async function validatePageToken(
  pageId: string,
  accessToken: string
): Promise<boolean> {
  await log.info("FACEBOOK", `→ validatePageToken(${pageId})`, {
    pageId,
    accessToken: maskToken(accessToken),
  });

  const startAt = Date.now();
  try {
    const url = `${GRAPH_API_BASE}/${pageId}`;
    const response = await axios.get<{ id: string; name: string }>(url, {
      params: { access_token: accessToken, fields: "id,name" },
      timeout: 8000,
    });
    const duration = Date.now() - startAt;
    const isValid = response.data?.id === pageId;
    await log.info("FACEBOOK", `← validatePageToken(${pageId}) → ${isValid ? "VALID" : "MISMATCH"} (${duration}ms)`, {
      pageId,
      returnedId: response.data?.id,
      pageName: response.data?.name,
      isValid,
      duration,
    });
    return isValid;
  } catch (err: unknown) {
    const duration = Date.now() - startAt;
    const axiosErr = err as { response?: { data?: unknown }; message?: string };
    const fbError = (axiosErr?.response?.data as { error?: { message?: string; code?: number } })?.error;
    const message = fbError?.message ?? axiosErr?.message ?? "Unknown error";
    await log.warn("FACEBOOK", `← validatePageToken(${pageId}) → INVALID (${duration}ms): ${message}`, {
      pageId,
      duration,
      fbErrorCode: fbError?.code,
      fbErrorMessage: fbError?.message,
    });
    return false;
  }
}

// Maximum length for any extracted lead field value.
// Prevents oversized payloads from Facebook form submissions being stored,
// forwarded to affiliate APIs, or injected into Telegram messages.
const MAX_LEAD_FIELD_LENGTH = 512;

function sanitizeFieldValue(val: string | null | undefined): string | null {
  if (!val) return null;
  // Trim whitespace and enforce max length
  const trimmed = val.trim().slice(0, MAX_LEAD_FIELD_LENGTH);
  return trimmed || null;
}

/**
 * Extract common fields from lead field_data array.
 */
export function extractLeadFields(fieldData: LeadFieldData[]): {
  fullName: string | null;
  phone: string | null;
  email: string | null;
} {
  // Exact match (case-insensitive)
  const getExact = (names: string[]): string | null => {
    for (const name of names) {
      const field = fieldData.find((f) => f.name.toLowerCase() === name.toLowerCase());
      if (field?.values?.[0]) return sanitizeFieldValue(field.values[0]);
    }
    return null;
  };

  // Partial/substring match as fallback (e.g. "полное_имя" contains "имя")
  const getPartial = (keywords: string[]): string | null => {
    for (const kw of keywords) {
      const field = fieldData.find((f) => f.name.toLowerCase().includes(kw.toLowerCase()));
      if (field?.values?.[0]) return sanitizeFieldValue(field.values[0]);
    }
    return null;
  };

  const fullName =
    getExact([
      // English
      "full_name", "name", "first_name", "last_name",
      // Russian
      "полное_имя", "полное имя", "имя", "фамилия", "имя_фамилия", "фио",
      // Uzbek
      "to'liq_ism", "to'liq ism", "ism", "ism_familiya", "ismi", "familiya",
      "toliq_ism", "toliq ism",
    ]) ??
    getPartial(["имя", "name", "ism", "фио"]);

  const phone =
    getExact([
      // English
      "phone_number", "phone", "mobile", "mobile_number", "contact_number",
      // Russian
      "номер_телефона", "номер телефона", "телефон", "телефон_номер",
      // Uzbek
      "telefon", "telefon_raqam", "telefon raqam", "raqam",
    ]) ??
    getPartial(["телефон", "phone", "mobile", "telefon", "raqam", "номер"]);

  const email =
    getExact(["email", "email_address", "почта", "электронная_почта", "e-mail"]) ??
    getPartial(["email", "почта"]);

  return { fullName, phone, email };
}
