import { buildGenericProvider, type GenericOAuthConfigJson } from "./generic.provider";

const config: GenericOAuthConfigJson = {
  authorizeUrl: "https://app.hubspot.com/oauth/authorize",
  tokenUrl: "https://api.hubapi.com/oauth/v1/token",
  clientIdEnv: "HUBSPOT_CLIENT_ID",
  clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
  scopes: ["crm.objects.contacts.write", "crm.objects.contacts.read"],
};

export const hubspotProvider = buildGenericProvider("hubspot", "hubspot", config);
