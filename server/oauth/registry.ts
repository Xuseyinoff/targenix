import type { OAuthProviderSpec } from "./types";

const providers = new Map<string, OAuthProviderSpec>();

export function registerProvider(p: OAuthProviderSpec): void {
  providers.set(p.name, p);
}

export function getProvider(name: string): OAuthProviderSpec | undefined {
  return providers.get(name);
}

export function listRegisteredProviderNames(): string[] {
  return Array.from(providers.keys());
}
