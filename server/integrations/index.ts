/**
 * Integrations barrel. Importing this module guarantees that:
 *   1. every delivery adapter is registered (./apps transitively imports
 *      ./register which calls registerAdapter for each built-in adapter)
 *   2. every Phase 2 app manifest is registered and validated
 *
 * Consumers on the delivery hot path (worker → leadService → dispatch.ts)
 * only need ./register — importing this barrel is unnecessary overhead for
 * them. The barrel is intended for web-side consumers (tRPC routers, admin
 * tooling) that need the metadata layer.
 */

import "./apps";

export { getAdapter, listAdapters } from "./registry";
export { resolveAdapterKey } from "./resolveAdapterKey";
export { dispatchDelivery } from "./dispatch";
export type { DispatchContext, DispatchOutcome } from "./dispatch";

export {
  getApp,
  listApps,
  validateAppRegistry,
  validateAllAppFieldSchemas,
} from "./appRegistry";
export type { ListAppsOptions } from "./appRegistry";
export { validateManifestFields } from "./manifestValidation";
export type { ManifestProblem } from "./manifestValidation";
export type {
  AppManifest,
  AppModule,
  AppCategory,
  AppAvailability,
  ConnectionType,
  ConfigField,
  ConfigFieldOption,
  ConfigFieldShowWhen,
  ConfigFieldType,
  ConfigFieldValidation,
  ConnectionPickerType,
} from "./manifest";
