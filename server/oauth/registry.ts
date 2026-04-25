import type { OAuthProviderSpec } from "./types";

const providers = new Map<string, OAuthProviderSpec>();

export function registerProvider(p: OAuthProviderSpec): void {
  providers.set(p.name, p);
}

export function getProvider(name: string): OAuthProviderSpec | undefined {
  return providers.get(name);
}

/** Resolve provider by `oauth_tokens.appKey` (e.g. `google-sheets`). */
export function getProviderByAppKey(appKey: string): OAuthProviderSpec | undefined {
  for (const p of Array.from(providers.values())) {
    if (p.integrationAppKey === appKey) return p;
  }
  return undefined;
}

export function listRegisteredProviderNames(): string[] {
  return Array.from(providers.keys());
}
