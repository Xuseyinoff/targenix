import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { httpRequestAdapter } from "./httpRequestAdapter";
import axios from "axios";

vi.mock("axios", async () => {
  const actual = await vi.importActual<typeof import("axios")>("axios");
  return { default: { ...actual.default, request: vi.fn() } };
});

vi.mock("../../lib/urlSafety", () => ({
  assertSafeOutboundUrl: vi.fn().mockResolvedValue(undefined),
}));

const mockedAxios = axios as unknown as { request: ReturnType<typeof vi.fn> };

const baseLead = {
  leadgenId: "lead-1",
  fullName: "Alice Smith",
  phone: "+998901234567",
  email: "alice@example.com",
  pageId: "p1",
  formId: "f1",
};

beforeEach(() => {
  mockedAxios.request.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("httpRequestAdapter — universal HTTP delivery", () => {
  it("rejects requests without a URL", async () => {
    const r = await httpRequestAdapter.send({}, baseLead);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/URL/);
  });

  it("renders {{variable}} placeholders in the URL and JSON body", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/leads/{{leadgen_id}}",
        method: "POST",
        bodyGroup: {
          contentType: "json",
          bodyTemplate: '{"name":"{{full_name}}","phone":"{{phone_number}}"}',
        },
      },
      baseLead,
    );

    expect(mockedAxios.request).toHaveBeenCalledTimes(1);
    const sent = mockedAxios.request.mock.calls[0][0];
    expect(sent.url).toBe("https://api.example.com/leads/lead-1");
    expect(sent.data).toContain('"name":"Alice Smith"');
    expect(sent.data).toContain('"phone":"+998901234567"');
    expect(sent.headers["Content-Type"]).toBe("application/json");
  });

  it("applies Bearer authentication when scheme=bearer", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/x",
        method: "POST",
        authentication: { scheme: "bearer", bearerToken: "secret-token-123" },
        bodyGroup: { contentType: "json", bodyTemplate: "{}" },
      },
      baseLead,
    );

    const sent = mockedAxios.request.mock.calls[0][0];
    expect(sent.headers["Authorization"]).toBe("Bearer secret-token-123");
  });

  it("applies API-key authentication via custom header name", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/x",
        method: "POST",
        authentication: { scheme: "api_key_header", apiKeyHeader: "X-Api-Key", apiKeyValue: "abc123" },
        bodyGroup: { contentType: "json", bodyTemplate: "{}" },
      },
      baseLead,
    );

    const sent = mockedAxios.request.mock.calls[0][0];
    expect(sent.headers["X-Api-Key"]).toBe("abc123");
    expect(sent.headers["Authorization"]).toBeUndefined();
  });

  it("applies Basic authentication via base64-encoded username:password", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/x",
        method: "POST",
        authentication: { scheme: "basic", basicUsername: "user", basicPassword: "pass" },
        bodyGroup: { contentType: "json", bodyTemplate: "{}" },
      },
      baseLead,
    );

    const sent = mockedAxios.request.mock.calls[0][0];
    const expected = `Basic ${Buffer.from("user:pass").toString("base64")}`;
    expect(sent.headers["Authorization"]).toBe(expected);
  });

  it("appends query parameters with {{variable}} expansion", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/x",
        method: "GET",
        advanced: { queryParams: [{ name: "utm_source", value: "{{page_id}}" }] },
      },
      baseLead,
    );

    const sent = mockedAxios.request.mock.calls[0][0];
    expect(sent.url).toBe("https://api.example.com/x?utm_source=p1");
    expect(sent.data).toBeUndefined();
  });

  it("omits the body for GET / DELETE", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/x",
        method: "DELETE",
        bodyGroup: { contentType: "json", bodyTemplate: '{"x":1}' },
      },
      baseLead,
    );

    const sent = mockedAxios.request.mock.calls[0][0];
    expect(sent.data).toBeUndefined();
  });

  it("encodes form-urlencoded bodies via URLSearchParams", async () => {
    mockedAxios.request.mockResolvedValue({ status: 200, data: {}, headers: {} });

    await httpRequestAdapter.send(
      {
        url: "https://api.example.com/x",
        method: "POST",
        bodyGroup: {
          contentType: "form-urlencoded",
          bodyFields: [
            { key: "name", value: "{{full_name}}" },
            { key: "phone", value: "{{phone_number}}" },
          ],
        },
      },
      baseLead,
    );

    const sent = mockedAxios.request.mock.calls[0][0];
    expect(sent.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = (sent.data as URLSearchParams).toString();
    expect(body).toContain("name=Alice+Smith");
    expect(body).toContain("phone=%2B998901234567");
  });

  it("returns success on 2xx response", async () => {
    mockedAxios.request.mockResolvedValue({ status: 201, data: { id: 99 }, headers: {} });

    const r = await httpRequestAdapter.send(
      { url: "https://api.example.com/x", method: "POST", bodyGroup: { contentType: "json", bodyTemplate: "{}" } },
      baseLead,
    );
    expect(r.success).toBe(true);
    expect(r.responseData).toEqual({ id: 99 });
  });

  it("returns failure with errorType=rate_limit on 429", async () => {
    mockedAxios.request.mockResolvedValue({ status: 429, data: { msg: "slow down" }, headers: {} });

    const r = await httpRequestAdapter.send(
      { url: "https://api.example.com/x", method: "POST", bodyGroup: { contentType: "json", bodyTemplate: "{}" } },
      baseLead,
    );
    expect(r.success).toBe(false);
    expect(r.errorType).toBe("rate_limit");
  });

  it("treats 4xx as validation, 5xx as network", async () => {
    mockedAxios.request.mockResolvedValueOnce({ status: 400, data: "bad request", headers: {} });
    const r1 = await httpRequestAdapter.send(
      { url: "https://api.example.com/x", method: "POST", bodyGroup: { contentType: "json", bodyTemplate: "{}" } },
      baseLead,
    );
    expect(r1.errorType).toBe("validation");

    mockedAxios.request.mockResolvedValueOnce({ status: 503, data: "upstream", headers: {} });
    const r2 = await httpRequestAdapter.send(
      { url: "https://api.example.com/x", method: "POST", bodyGroup: { contentType: "json", bodyTemplate: "{}" } },
      baseLead,
    );
    expect(r2.errorType).toBe("network");
  });
});
