export function resolveAdapterKey(
  integrationType: string,
  tw?: {
    templateId?: number | null;
    templateType?: string | null;
  } | null,
): string {
  if (integrationType === "AFFILIATE") return "affiliate";

  if (!tw) return "plain-url";

  if (tw.templateId) return "dynamic-template";

  if (tw.templateType === "telegram") return "telegram";

  if (tw.templateType === "google-sheets") return "google-sheets";

  if (tw.templateType) return "legacy-template";

  return "plain-url";
}
