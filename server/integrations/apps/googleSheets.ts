import type { AppManifest } from "../manifest";

/**
 * Loader keys referenced by the fields below. These strings are the *identity*
 * of each loader — Commit 2 will mount a single tRPC router that reads
 * manifest.dynamicOptionsLoaders and dispatches the matching handler. Keep the
 * strings stable; renaming them is a breaking change for any persisted form
 * state that references them by key.
 */
const LOADERS = {
  LIST_SPREADSHEETS: "google-sheets.listSpreadsheets",
  LIST_SHEET_TABS: "google-sheets.listSheetTabs",
  GET_SHEET_HEADERS: "google-sheets.getSheetHeaders",
} as const;

export const googleSheetsApp: AppManifest = {
  key: "google-sheets",
  name: "Google Sheets",
  version: "1.1.0",
  icon: "Table2",
  category: "spreadsheet",
  description: "Append each lead as a new row in a Google Sheets spreadsheet.",
  adapterKey: "google-sheets",
  connectionType: "oauth2_google",
  modules: [
    {
      key: "append_row",
      name: "Append row",
      kind: "action",
      description: "Append one row per lead to the chosen tab of a Google Sheet.",
      fields: [
        {
          key: "connectionId",
          type: "connection-picker",
          label: "Google account",
          description: "Pick a Google account from your Connections, or add a new one.",
          required: true,
          connectionType: "google_sheets",
        },
        {
          key: "spreadsheetId",
          type: "async-select",
          label: "Spreadsheet",
          description: "Choose one of the spreadsheets from the selected Google account.",
          required: true,
          optionsSource: LOADERS.LIST_SPREADSHEETS,
          dependsOn: ["connectionId"],
        },
        {
          key: "sheetName",
          type: "async-select",
          label: "Sheet (tab)",
          description: "The tab inside the spreadsheet that new rows will be appended to.",
          required: true,
          optionsSource: LOADERS.LIST_SHEET_TABS,
          dependsOn: ["connectionId", "spreadsheetId"],
        },
        {
          key: "mapping",
          type: "field-mapping",
          label: "Column mapping",
          description: "Map each column header in the sheet to a lead variable.",
          required: false,
          headersSource: LOADERS.GET_SHEET_HEADERS,
          dependsOn: ["connectionId", "spreadsheetId", "sheetName"],
        },
      ],
    },
  ],
  dynamicOptionsLoaders: {
    [LOADERS.LIST_SPREADSHEETS]: "appsRouter.googleSheets.listSpreadsheets",
    [LOADERS.LIST_SHEET_TABS]: "appsRouter.googleSheets.listSheetTabs",
    [LOADERS.GET_SHEET_HEADERS]: "appsRouter.googleSheets.getSheetHeaders",
  },
  availability: "stable",
};
