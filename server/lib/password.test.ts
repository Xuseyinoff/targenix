/**
 * Unit tests for the argon2id password helper.
 *
 * The bcrypt backward-compat path is the load-bearing piece: every
 * existing user in the DB still has a `$2[aby]$…` hash, and a regression
 * here would lock them out. These tests pin:
 *   - new hashes are argon2id
 *   - argon2id hashes verify correctly
 *   - legacy bcrypt hashes still verify
 *   - legacy bcrypt verification signals needsRehash=true so the login
 *     flow can upgrade the row
 *   - malformed input does not throw
 */
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword, verifyPassword } from "./password";

describe("hashPassword", () => {
  it("returns an argon2id hash (starts with $argon2id$)", async () => {
    const hash = await hashPassword("hunter2!");
    expect(hash.startsWith("$argon2id$")).toBe(true);
  });

  it("produces different hashes for the same input (random salt)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("throws on empty plaintext", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});

describe("verifyPassword — argon2id roundtrip", () => {
  it("returns ok=true + needsRehash=false for a matching argon2 hash", async () => {
    const hash = await hashPassword("correct-password");
    const result = await verifyPassword("correct-password", hash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(false);
  });

  it("returns ok=false + needsRehash=false for a wrong password against argon2", async () => {
    const hash = await hashPassword("correct-password");
    const result = await verifyPassword("wrong-password", hash);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });
});

describe("verifyPassword — legacy bcrypt backward compat", () => {
  it("verifies a $2b$ bcrypt hash and signals needsRehash=true on success", async () => {
    // Simulate the hash format already in the DB.
    const bcryptHash = await bcrypt.hash("legacy-password", 10);
    expect(bcryptHash.startsWith("$2")).toBe(true);

    const result = await verifyPassword("legacy-password", bcryptHash);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  it("returns ok=false on a wrong password against a bcrypt hash", async () => {
    const bcryptHash = await bcrypt.hash("legacy-password", 10);
    const result = await verifyPassword("wrong-password", bcryptHash);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });
});

describe("verifyPassword — defensive cases", () => {
  it("returns ok=false when storedHash is null", async () => {
    const result = await verifyPassword("anything", null);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it("returns ok=false when storedHash is undefined", async () => {
    const result = await verifyPassword("anything", undefined);
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });

  it("returns ok=false when plaintext is empty", async () => {
    const hash = await hashPassword("real-password");
    const result = await verifyPassword("", hash);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false for an unknown hash format without throwing", async () => {
    const result = await verifyPassword("password", "totally-not-a-hash");
    expect(result.ok).toBe(false);
    expect(result.needsRehash).toBe(false);
  });
});
