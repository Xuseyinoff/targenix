/**
 * Loader registration barrel. Importing this file has the side effect of
 * populating the loader registry with every built-in loader.
 *
 * Importers:
 *   • server/routers/appsRouter.ts — imports this so loadOptions can dispatch
 *   • server/integrations/loaders/*.test.ts — reset + re-import to test
 *
 * Loaders that require an optional feature (e.g. Telegram group listings)
 * should still register — the manifest controls visibility, not the registry.
 */

import { registerGoogleSheetsLoaders } from "./googleSheets";
import { registerTelegramLoaders } from "./telegram";

registerGoogleSheetsLoaders();
registerTelegramLoaders();
