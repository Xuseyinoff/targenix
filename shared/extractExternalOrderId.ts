/**
 * Affiliate platformlaridan kelgan order javobidan tashqi (platform) buyurtma ID.
 * Sotuvchi: `{ ok: "true", id: 694147 }`
 * 100k: ko‘pincha `{ data: { id } }`, ba’zan ichki `data` yoki `order` ichida.
 */

function pickFromRecord(obj: Record<string, unknown>): string | null {
  if (obj.id != null && obj.id !== "") return String(obj.id);
  if (obj.order_id != null && obj.order_id !== "") return String(obj.order_id);

  const data = obj.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const d = data as Record<string, unknown>;
    if (d.id != null && d.id !== "") return String(d.id);
    if (d.order_id != null && d.order_id !== "") return String(d.order_id);
    const inner = d.data;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const i = inner as Record<string, unknown>;
      if (i.id != null && i.id !== "") return String(i.id);
    }
  }

  const order = obj.order;
  if (order && typeof order === "object" && !Array.isArray(order)) {
    const o = order as Record<string, unknown>;
    if (o.id != null && o.id !== "") return String(o.id);
  }

  return null;
}

export function extractExternalOrderId(responseData: unknown): string | null {
  if (!responseData || typeof responseData !== "object") return null;
  const root = responseData as Record<string, unknown>;

  const direct = pickFromRecord(root);
  if (direct) return direct;

  const body = root.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return pickFromRecord(body as Record<string, unknown>);
  }

  return null;
}
