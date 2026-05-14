/**
 * monitoring/metrics — counter increment + read-and-reset semantics.
 * The capture path in metricSnapshotScheduler depends on this being
 * truly atomic-ish (single-threaded event loop, no interleaving),
 * so tests pin the contract.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  incFailedOrders,
  incOAuthErrors,
  peekCounters,
  readAndResetCounters,
} from "./metrics";

describe("metrics — in-process counters", () => {
  beforeEach(() => {
    // Drain any state leftover from earlier tests in this file.
    readAndResetCounters();
  });

  it("increments and peeks without mutating", () => {
    incFailedOrders(3);
    incOAuthErrors(2);
    expect(peekCounters()).toEqual({ failedOrders: 3, oauthErrors: 2 });
    // peek must not mutate
    expect(peekCounters()).toEqual({ failedOrders: 3, oauthErrors: 2 });
  });

  it("readAndResetCounters returns the snapshot and zeroes the state", () => {
    incFailedOrders(7);
    incOAuthErrors(11);
    expect(readAndResetCounters()).toEqual({ failedOrders: 7, oauthErrors: 11 });
    expect(peekCounters()).toEqual({ failedOrders: 0, oauthErrors: 0 });
  });

  it("accumulates increments across multiple calls", () => {
    incFailedOrders();
    incFailedOrders();
    incFailedOrders(5);
    expect(peekCounters().failedOrders).toBe(7);
  });

  it("clamps negative or fractional increments to zero", () => {
    incFailedOrders(-3);
    incFailedOrders(2.7);
    expect(peekCounters().failedOrders).toBe(2);
  });

  it("returns all-zeros when read-and-reset is called on an idle counter", () => {
    expect(readAndResetCounters()).toEqual({ failedOrders: 0, oauthErrors: 0 });
  });
});
