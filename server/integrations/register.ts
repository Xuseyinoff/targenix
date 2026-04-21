/**
 * Side-effect-only module that registers every built-in delivery adapter in
 * the adapter registry. Imported at boot from both the web process (via the
 * `integrations` barrel / integrationsRouter) and the worker process (via
 * dispatch.ts) so the registry is always populated before dispatch runs.
 *
 * Duplicate imports are safe — registerAdapter is idempotent (Map.set overwrites).
 */

import { registerAdapter } from "./registry";
import { affiliateAdapter } from "./adapters/affiliateAdapter";
import { plainUrlAdapter } from "./adapters/plainUrlAdapter";
import { legacyTemplateAdapter } from "./adapters/legacyTemplateAdapter";
import { dynamicTemplateAdapter } from "./adapters/dynamicTemplateAdapter";
import { telegramAdapter } from "./adapters/telegramAdapter";
import { googleSheetsAdapter } from "./adapters/googleSheetsAdapter";

registerAdapter("affiliate", affiliateAdapter);
registerAdapter("plain-url", plainUrlAdapter);
registerAdapter("legacy-template", legacyTemplateAdapter);
registerAdapter("dynamic-template", dynamicTemplateAdapter);
registerAdapter("telegram", telegramAdapter);
registerAdapter("google-sheets", googleSheetsAdapter);
