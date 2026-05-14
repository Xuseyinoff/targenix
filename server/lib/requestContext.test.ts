/**
 * requestContext — verifies AsyncLocalStorage propagation behaves as
 * advertised: ids stick across awaits, nested contexts shadow correctly,
 * and `getTraceId()` returns undefined outside any run scope.
 */

import { describe, it, expect } from "vitest";
import {
  runWithRequestContext,
  getRequestContext,
  getTraceId,
  newHttpTraceId,
  newSchedulerTraceId,
  newWorkerTraceId,
  newWebhookTraceId,
} from "./requestContext";

describe("requestContext — ALS propagation", () => {
  it("returns undefined outside any run scope", () => {
    expect(getTraceId()).toBeUndefined();
    expect(getRequestContext()).toBeUndefined();
  });

  it("propagates traceId through synchronous calls", () => {
    let captured: string | undefined;
    runWithRequestContext({ traceId: "test-1", kind: "http" }, () => {
      captured = getTraceId();
    });
    expect(captured).toBe("test-1");
  });

  it("propagates traceId across awaits in async chains", async () => {
    const captured: Array<string | undefined> = [];
    await runWithRequestContext({ traceId: "test-2", kind: "scheduler" }, async () => {
      captured.push(getTraceId());
      await new Promise((r) => setImmediate(r));
      captured.push(getTraceId());
      await Promise.resolve().then(() => captured.push(getTraceId()));
      await new Promise((r) => setTimeout(r, 5));
      captured.push(getTraceId());
    });
    expect(captured).toEqual(["test-2", "test-2", "test-2", "test-2"]);
  });

  it("does not leak context to sibling async chains", async () => {
    const a: string[] = [];
    const b: string[] = [];
    await Promise.all([
      runWithRequestContext({ traceId: "A", kind: "http" }, async () => {
        a.push(getTraceId()!);
        await new Promise((r) => setTimeout(r, 10));
        a.push(getTraceId()!);
      }),
      runWithRequestContext({ traceId: "B", kind: "http" }, async () => {
        b.push(getTraceId()!);
        await new Promise((r) => setTimeout(r, 5));
        b.push(getTraceId()!);
      }),
    ]);
    expect(a).toEqual(["A", "A"]);
    expect(b).toEqual(["B", "B"]);
  });

  it("nested run scopes shadow the outer context, then restore it", () => {
    const trace: Array<string | undefined> = [];
    runWithRequestContext({ traceId: "outer", kind: "http" }, () => {
      trace.push(getTraceId());
      runWithRequestContext({ traceId: "inner", kind: "scheduler" }, () => {
        trace.push(getTraceId());
      });
      trace.push(getTraceId());
    });
    expect(trace).toEqual(["outer", "inner", "outer"]);
  });

  it("exposes the full context including kind and name", () => {
    let captured: ReturnType<typeof getRequestContext>;
    runWithRequestContext(
      { traceId: "T", kind: "worker", name: "lead-processing" },
      () => {
        captured = getRequestContext();
      },
    );
    expect(captured).toEqual({
      traceId: "T",
      kind: "worker",
      name: "lead-processing",
    });
  });
});

describe("requestContext — trace id factories", () => {
  it("newHttpTraceId returns 'req-' prefixed UUIDs", () => {
    const id = newHttpTraceId();
    expect(id.startsWith("req-")).toBe(true);
    // UUID v4 with hyphens is 36 chars; prefix is "req-" (4 chars)
    expect(id.length).toBe(40);
  });

  it("newHttpTraceId returns distinct ids on repeated calls", () => {
    const ids = new Set([newHttpTraceId(), newHttpTraceId(), newHttpTraceId()]);
    expect(ids.size).toBe(3);
  });

  it("newSchedulerTraceId embeds the scheduler name", () => {
    const id = newSchedulerTraceId("retry");
    expect(id.startsWith("sched-retry-")).toBe(true);
    // sched-retry- (12 chars) + 8 short uuid chars = 20
    expect(id.length).toBe(20);
  });

  it("newWorkerTraceId embeds the queue + job id", () => {
    expect(newWorkerTraceId("lead-processing", 42)).toBe("job-lead-processing-42");
    expect(newWorkerTraceId("lead-processing", "abc-123")).toBe("job-lead-processing-abc-123");
  });

  it("newWebhookTraceId embeds the source", () => {
    const id = newWebhookTraceId("facebook");
    expect(id.startsWith("wh-facebook-")).toBe(true);
  });
});
