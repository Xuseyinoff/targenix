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

export { getAdapter, listAdapters } from "./registry";
