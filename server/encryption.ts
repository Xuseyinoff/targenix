/**
 * Symmetric encryption helpers for secret-at-rest storage.
 *
 * History:
 *   - v0 (initial): AES-256-CBC, no authentication. Format:
 *       `<iv-hex>:<ciphertext-hex>`
 *     CBC is correct but does not detect tampering — a flipped bit in
 *     the ciphertext would silently decrypt to garbled plaintext.
 *
 *   - v1 (2026-05-12): AES-256-GCM, authenticated. Format:
 *       `gcm:<iv-hex>:<authTag-hex>:<ciphertext-hex>`
 *     12-byte IV (the GCM standard recommendation), 16-byte auth tag.
 *     Tampering produces a decryption error instead of garbled output.
 *
 * `encrypt()` always writes the v1 format.
 * `decrypt()` accepts BOTH formats — every existing CBC blob in the DB
 *   continues to work without a data migration. As rows are
 *   re-encrypted (e.g. user updates an API key, OAuth refresh writes
 *   a new token) they automatically migrate to v1.
 *
 * No manual backfill is required.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";

const V1_PREFIX = "gcm:";

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY environment variable is required");
  return createHash("sha256").update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV is the GCM standard
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return (
    V1_PREFIX +
    iv.toString("hex") +
    ":" +
    tag.toString("hex") +
    ":" +
    encrypted.toString("hex")
  );
}

export function decrypt(ciphertext: string): string {
  if (ciphertext.startsWith(V1_PREFIX)) {
    return decryptGcm(ciphertext.slice(V1_PREFIX.length));
  }
  return decryptCbc(ciphertext);
}

function decryptGcm(body: string): string {
  const [ivHex, tagHex, encHex] = body.split(":");
  if (!ivHex || !tagHex || !encHex) {
    throw new Error("Invalid ciphertext format (v1/gcm)");
  }
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

function decryptCbc(ciphertext: string): string {
  const [ivHex, encHex] = ciphertext.split(":");
  if (!ivHex || !encHex) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", getKey(), iv);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
