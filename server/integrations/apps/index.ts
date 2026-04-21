/**
 * App manifest barrel. MUST be imported by anything that needs the app
 * registry populated — web process / tRPC routers.
 *
 * Order matters:
 *   1. "../register" first — registers delivery adapters in the registry.
 *   2. Manifest imports — each manifest is a plain object (no side effects).
 *   3. registerApp(…) calls — validate adapterKey against the adapter registry.
 *
 * Because ES module side effects run in import order, importing "../register"
 * above the manifest imports guarantees the adapter registry is populated
 * before registerApp's sanity check runs.
 */

import "../register";

import { registerApp } from "../appRegistry";
import { telegramApp } from "./telegram";
import { googleSheetsApp } from "./googleSheets";
import { httpWebhookApp } from "./httpWebhook";
import { dynamicTemplateApp } from "./dynamicTemplate";
import { legacyTemplateApp } from "./legacyTemplate";
import { affiliateApp } from "./affiliate";

registerApp(telegramApp);
registerApp(googleSheetsApp);
registerApp(httpWebhookApp);
registerApp(dynamicTemplateApp);
registerApp(legacyTemplateApp);
registerApp(affiliateApp);
