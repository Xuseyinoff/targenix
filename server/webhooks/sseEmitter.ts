import type { Response } from "express";

// In-memory set of connected SSE clients
const clients = new Set<Response>();

export function addSseClient(res: Response): void {
  clients.add(res);
  res.on("close", () => {
    clients.delete(res);
  });
}

export function emitWebhookEvent(data: {
  type: "incoming" | "processed" | "error";
  eventId?: number;
  leadgenId?: string;
  pageId?: string;
  formId?: string;
  verified?: boolean;
  processed?: boolean;
  error?: string;
  timestamp: string;
}): void {
  if (clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of Array.from(clients)) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function getSseClientCount(): number {
  return clients.size;
}
