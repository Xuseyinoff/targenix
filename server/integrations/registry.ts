import type { DeliveryAdapter } from "./types";

const adapters = new Map<string, DeliveryAdapter>();

export function registerAdapter(key: string, adapter: DeliveryAdapter): void {
  adapters.set(key, adapter);
}

export function getAdapter(key: string): DeliveryAdapter | null {
  return adapters.get(key) ?? null;
}

export function listAdapters(): string[] {
  return Array.from(adapters.keys());
}
