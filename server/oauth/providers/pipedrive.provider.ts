import { buildGenericProvider, type GenericOAuthConfigJson } from "./generic.provider";

const config: GenericOAuthConfigJson = {
  authorizeUrl: "https://oauth.pipedrive.com/oauth/authorize",
  tokenUrl: "https://oauth.pipedrive.com/oauth/token",
  clientIdEnv: "PIPEDRIVE_CLIENT_ID",
  clientSecretEnv: "PIPEDRIVE_CLIENT_SECRET",
  scopes: ["contacts:full", "deals:full"],
};

export const pipedriveProvider = buildGenericProvider("pipedrive", "pipedrive", config);
