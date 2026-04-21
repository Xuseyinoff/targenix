import type { AppManifest } from "../manifest";

export const googleSheetsApp: AppManifest = {
  key: "google-sheets",
  name: "Google Sheets",
  version: "1.0.0",
  icon: "Table2",
  category: "spreadsheet",
  description: "Append each lead as a new row in a Google Sheets spreadsheet.",
  adapterKey: "google-sheets",
  connectionType: "oauth2_google",
  modules: [{ key: "append_row", name: "Append row", kind: "action" }],
  availability: "stable",
};
