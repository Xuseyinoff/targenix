/** Lead fields available for Google Sheets column mapping (shared UI + server). */
export const GOOGLE_SHEETS_MAPPABLE_FIELDS = [
  "fullName",
  "phone",
  "email",
  "createdAt",
  "leadgenId",
  "pageId",
  "formId",
] as const;

export type GoogleSheetsMappableField = (typeof GOOGLE_SHEETS_MAPPABLE_FIELDS)[number];
