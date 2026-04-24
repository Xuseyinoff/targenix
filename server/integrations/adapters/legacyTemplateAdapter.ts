import {
  sendAffiliateOrderByTemplate,
  type TemplateType,
  type TemplateConfig,
  type LeadPayload,
} from "../../services/affiliateService";
import type { Connection } from "../../../drizzle/schema";
import type { DeliveryAdapter, DeliveryResult } from "../types";
import type { DbClient } from "../../db";

interface LegacyTemplateConfig {
  /** Optional; when set, may resolve spec metadata from `apps` if needed. */
  db?: DbClient | null;
  templateType: TemplateType;
  templateConfig: TemplateConfig;
  variableFields: Record<string, string>;
  url: string | null | undefined;
  /**
   * Stage 2 — linked connection row (if any). When active and
   * populated, its `credentialsJson.secretsEncrypted` becomes the
   * authoritative source for `{{SECRET:key}}` tokens. Legacy
   * destinations without a connection pass `null` / `undefined`, in
   * which case `sendAffiliateOrderByTemplate` falls back to
   * `templateConfig.secrets` exactly as before.
   */
  connection?: Connection | null;
  /**
   * Stage 3 — tenant id of the destination's owner. Threaded through
   * to `resolveSecretsForDelivery` so the `USE_CONNECTION_SECRETS_ONLY`
   * feature flag can be evaluated per-user. Optional so legacy
   * unit tests that instantiate the adapter directly keep compiling.
   */
  userId?: number | null;
}

export const legacyTemplateAdapter: DeliveryAdapter = {
  async send(config: unknown, lead: LeadPayload): Promise<DeliveryResult> {
    const {
      db,
      templateType,
      templateConfig,
      variableFields,
      url,
      connection,
      userId,
    } = config as LegacyTemplateConfig;
    return sendAffiliateOrderByTemplate(
      templateType,
      templateConfig,
      lead,
      variableFields,
      url ?? "",
      connection ?? null,
      userId ?? null,
      db ?? null,
    );
  },
};
