import { describe, expect, it } from "vitest";
import {
  getApp,
  listApps,
  listAdapters,
  validateAppRegistry,
  validateAllAppFieldSchemas,
} from "./index";

describe("app registry (Phase 2 manifests)", () => {
  it("every registered app points at an existing adapter", () => {
    // validateAppRegistry returns a list of mismatches — empty == healthy.
    const problems = validateAppRegistry();
    expect(problems).toEqual([]);
  });

  it("registers every built-in app (core + http-api-key + http-oauth2)", () => {
    // Keep this list in sync with server/integrations/apps/index.ts. The
    // assertion is intentionally a strict equality so adding a new manifest
    // file without registering it (or vice-versa) fails CI loudly.
    const keys = listApps({ includeInternal: true })
      .map((a) => a.key)
      .sort();
    expect(keys).toEqual(
      [
        // Core
        "dynamic-template",
        "google-sheets",
        "plain-url",
        "telegram",
        // Phase 9 — manifest-driven HTTP API-key apps
        "amocrm",
        "bitrix24",
        "crm-generic",
        "eskiz-sms",
        "openai",
        "playmobile-sms",
        "webhook-json",
        // Phase 12 — OAuth2 CRM apps
        "hubspot",
        "kommo",
        "pipedrive",
      ].sort(),
    );
  });

  it("listApps() hides the internal dynamic-template app by default", () => {
    const publicKeys = listApps().map((a) => a.key);
    expect(publicKeys).not.toContain("dynamic-template");
  });

  it("listApps() can include internal apps on request", () => {
    const all = listApps({ includeInternal: true }).map((a) => a.key);
    expect(all).toContain("dynamic-template");
  });

  it("public apps expose expected connection types", () => {
    const telegram = getApp("telegram");
    const sheets = getApp("google-sheets");
    const http = getApp("plain-url");
    const dyn = getApp("dynamic-template");

    expect(telegram?.connectionType).toBe("telegram_bot");
    expect(sheets?.connectionType).toBe("oauth2_google");
    expect(http?.connectionType).toBe("none");
    expect(dyn?.connectionType).toBe("none");
  });

  it("adapter registry includes every manifest adapterKey", () => {
    const adapterKeys = new Set(listAdapters());
    for (const app of listApps({ includeInternal: true })) {
      expect(adapterKeys.has(app.adapterKey)).toBe(true);
    }
  });

  it("every built-in app has a well-formed field schema", () => {
    // Commit 1 of Phase 4: manifests declare fields[] for the dynamic form.
    // Any malformed schema would break Commit 3's renderer, so fail hard here.
    const problems = validateAllAppFieldSchemas();
    expect(problems).toEqual([]);
  });

  it("telegram declares the send_message module with expected fields", () => {
    const telegram = getApp("telegram");
    expect(telegram).toBeTruthy();
    const send = telegram?.modules.find((m) => m.key === "send_message");
    expect(send?.fields?.map((f) => f.key)).toEqual([
      "connectionId",
      "chatId",
      "messageTemplate",
    ]);
    const conn = send?.fields?.find((f) => f.key === "connectionId");
    expect(conn?.type).toBe("connection-picker");
    expect(conn?.connectionType).toBe("telegram_bot");
    expect(conn?.required).toBe(true);
  });

  it("google-sheets declares the append_row module with cascading dependencies", () => {
    const sheets = getApp("google-sheets");
    expect(sheets).toBeTruthy();
    const append = sheets?.modules.find((m) => m.key === "append_row");
    const keys = append?.fields?.map((f) => f.key);
    expect(keys).toEqual(["connectionId", "spreadsheetId", "sheetName", "mapping"]);

    const sheet = append?.fields?.find((f) => f.key === "sheetName");
    expect(sheet?.type).toBe("async-select");
    expect(sheet?.dependsOn).toEqual(["connectionId", "spreadsheetId"]);

    const mapping = append?.fields?.find((f) => f.key === "mapping");
    expect(mapping?.type).toBe("field-mapping");
    expect(mapping?.dependsOn).toEqual([
      "connectionId",
      "spreadsheetId",
      "sheetName",
    ]);

    // Every optionsSource / headersSource must resolve through the manifest.
    const loaders = sheets?.dynamicOptionsLoaders ?? {};
    for (const f of append?.fields ?? []) {
      if (f.optionsSource) expect(loaders[f.optionsSource]).toBeTruthy();
      if (f.headersSource) expect(loaders[f.headersSource]).toBeTruthy();
    }
  });
});
