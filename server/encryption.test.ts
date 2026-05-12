import { describe, expect, it, beforeAll } from "vitest";
import { createCipheriv, createHash, randomBytes } from "crypto";
import { encrypt, decrypt } from "./encryption";

beforeAll(() => {
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = "vitest-test-encryption-key-min-32-chars!";
  }
});

function getKey(): Buffer {
  return createHash("sha256").update(process.env.ENCRYPTION_KEY!).digest();
}

/**
 * Helper: produce a legacy CBC ciphertext in the v0 format so we can
 * verify decrypt() still understands every blob already sitting in prod.
 */
function encryptCbcLegacy(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

describe("encryption helpers — v1 (AES-256-GCM)", () => {
  it("encrypts and decrypts a string correctly", () => {
    const original = "EAAxxxLongLivedAccessToken12345";
    const ciphertext = encrypt(original);
    expect(ciphertext).not.toBe(original);
    expect(ciphertext.startsWith("gcm:")).toBe(true);
    expect(ciphertext.split(":")).toHaveLength(4); // gcm:iv:tag:enc
    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertext for same input (random IV)", () => {
    const original = "same-token";
    const c1 = encrypt(original);
    const c2 = encrypt(original);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1)).toBe(original);
    expect(decrypt(c2)).toBe(original);
  });

  it("throws on tampered ciphertext (auth tag verification)", () => {
    const original = "important-secret";
    const ciphertext = encrypt(original);
    // Flip the last hex digit of the encrypted body to simulate tampering.
    const parts = ciphertext.split(":");
    const enc = parts[3]!;
    const tamperedHex =
      enc.slice(0, -1) + (enc[enc.length - 1] === "f" ? "0" : "f");
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedHex}`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it("throws on a malformed v1 blob (missing auth tag)", () => {
    expect(() => decrypt("gcm:abcd:ef")).toThrow(/Invalid ciphertext format/);
  });

  it("throws on totally unstructured input", () => {
    expect(() => decrypt("not-valid-ciphertext")).toThrow();
  });
});

describe("encryption helpers — v0 (legacy AES-256-CBC) backward compat", () => {
  it("decrypts a legacy CBC ciphertext without the gcm: prefix", () => {
    // Simulates a row that was encrypted before the v1 upgrade and is
    // still sitting in the DB. decrypt() must accept it transparently.
    const original = "old-stored-token-from-prod";
    const legacy = encryptCbcLegacy(original);
    expect(legacy.startsWith("gcm:")).toBe(false);
    expect(legacy.split(":")).toHaveLength(2); // iv:enc
    expect(decrypt(legacy)).toBe(original);
  });

  it("decrypts legacy CBC then re-encrypts to v1 GCM idempotently", () => {
    // The natural migration flow: read old blob, decrypt, write back.
    // Confirms a round-trip migration produces a v1 blob.
    const original = "rotated-api-key";
    const legacy = encryptCbcLegacy(original);
    const recovered = decrypt(legacy);
    const migrated = encrypt(recovered);
    expect(migrated.startsWith("gcm:")).toBe(true);
    expect(decrypt(migrated)).toBe(original);
  });
});
