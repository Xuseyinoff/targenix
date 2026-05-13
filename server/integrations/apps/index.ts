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
// Phase 9 — http-api-key apps
import { eskizSmsApp } from "./eskizSms";
import { playmobileSmsApp } from "./playmobileSms";
import { openAiApp } from "./openAi";
import { crmGenericApp } from "./crmGeneric";
// Phase 11 — new integrations
import { webhookJsonApp } from "./webhookJson";
import { bitrix24App } from "./bitrix24";
import { amocrmApp } from "./amocrm";
import { hubspotApp } from "./hubspot";
import { kommoApp } from "./kommo";
import { pipedriveApp } from "./pipedrive";
// Universal HTTP — consolidates webhook-json / plain-url / crm-generic.
import { httpRequestApp } from "./httpRequest";

registerApp(telegramApp);
registerApp(googleSheetsApp);
registerApp(httpWebhookApp);
registerApp(dynamicTemplateApp);
// Phase 9
registerApp(eskizSmsApp);
registerApp(playmobileSmsApp);
registerApp(openAiApp);
registerApp(crmGenericApp);
// Phase 11
registerApp(webhookJsonApp);
registerApp(bitrix24App);
registerApp(amocrmApp);
registerApp(hubspotApp);
registerApp(kommoApp);
registerApp(pipedriveApp);
registerApp(httpRequestApp);
