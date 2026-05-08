import { registerProvider } from "./registry";
import { googleProvider } from "./providers/google.provider";
import { hubspotProvider } from "./providers/hubspot.provider";
import { kommoProvider } from "./providers/kommo.provider";
import { pipedriveProvider } from "./providers/pipedrive.provider";

registerProvider(googleProvider);
registerProvider(hubspotProvider);
registerProvider(kommoProvider);
registerProvider(pipedriveProvider);
