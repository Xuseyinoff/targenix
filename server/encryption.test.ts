import { describe, expect, it } from "vitest";
import { encrypt, decrypt } from "./encryption";

describe("encryption helpers", () => {
  it("encrypts and decrypts a string correctly", () => {
    const original = "EAAxxxLongLivedAccessToken12345";
    const ciphertext = encrypt(original);
    expect(ciphertext).not.toBe(original);
    expect(ciphertext).toContain(":");
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

  it("throws on invalid ciphertext format", () => {
    expect(() => decrypt("not-valid-ciphertext")).toThrow();
  });
});
