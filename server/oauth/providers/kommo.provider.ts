import { buildGenericProvider, type GenericOAuthConfigJson } from "./generic.provider";

const config: GenericOAuthConfigJson = {
  authorizeUrl: "https://www.kommo.com/oauth/",
  tokenUrl: "https://www.kommo.com/oauth2/access_token",
  clientIdEnv: "KOMMO_CLIENT_ID",
  clientSecretEnv: "KOMMO_CLIENT_SECRET",
  scopes: [],
};

export const kommoProvider = buildGenericProvider("kommo", "kommo", config);
