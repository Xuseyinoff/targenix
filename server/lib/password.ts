/**
 * Password hashing helper — argon2id with bcrypt backward-compat.
 *
 * Rationale: bcrypt is correct but the pure-JS `bcryptjs` implementation is
 * slow under load (relative to native bindings) and bcrypt itself is
 * showing its age — GPU attacks make modern KDFs the better choice.
 * argon2id is OWASP's current recommendation for password storage.
 *
 * Strategy:
 *   - `hashPassword()` always writes argon2id.
 *   - `verifyPassword()` detects the hash format prefix and dispatches
 *     to argon2 (`$argon2id$…`) or bcrypt (`$2a$…` / `$2b$…`). Returns
 *     `{ ok, needsRehash }` — when `needsRehash` is true the caller
 *     SHOULD rewrite the user's row with `hashPassword(plaintext)` so
 *     legacy bcrypt rows quietly migrate on next login.
 *   - `bcryptjs` stays a dependency until the last bcrypt hash is gone
 *     from the DB (verify-only path). After that, run a one-line audit
 *     and remove the package.
 *
 * argon2id parameters are the OWASP-recommended defaults: 64 MiB memory,
 * 3 iterations, parallelism 4. Override via env if you need to tune.
 */
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from "@node-rs/argon2";
import bcrypt from "bcryptjs";
import { envInt } from "./envHelpers";

const ARGON_MEMORY_COST = envInt("ARGON_MEMORY_KB", 64 * 1024); // 64 MiB
const ARGON_TIME_COST = envInt("ARGON_TIME_COST", 3);
const ARGON_PARALLELISM = envInt("ARGON_PARALLELISM", 4);

const ARGON_PREFIX = "$argon2";
const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"];

export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("hashPassword: plaintext is required");
  return argon2Hash(plaintext, {
    memoryCost: ARGON_MEMORY_COST,
    timeCost: ARGON_TIME_COST,
    parallelism: ARGON_PARALLELISM,
    algorithm: Algorithm.Argon2id,
  });
}

export interface VerifyResult {
  /** Did the password match the stored hash? */
  ok: boolean;
  /**
   * True when the stored hash is in the legacy bcrypt format. Callers
   * SHOULD rehash via `hashPassword(plaintext)` and update the DB so
   * the bcrypt dependency can eventually be removed.
   */
  needsRehash: boolean;
}

export async function verifyPassword(
  plaintext: string,
  storedHash: string | null | undefined,
): Promise<VerifyResult> {
  if (!plaintext || !storedHash) {
    return { ok: false, needsRehash: false };
  }

  if (storedHash.startsWith(ARGON_PREFIX)) {
    try {
      const ok = await argon2Verify(storedHash, plaintext);
      return { ok, needsRehash: false };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }

  if (BCRYPT_PREFIXES.some((p) => storedHash.startsWith(p))) {
    try {
      const ok = await bcrypt.compare(plaintext, storedHash);
      // ok==true means the password matched; signal upgrade so the
      // caller can quietly rehash with argon2id on this login.
      return { ok, needsRehash: ok };
    } catch {
      return { ok: false, needsRehash: false };
    }
  }

  // Unknown format — log and reject. Don't throw, callers shouldn't
  // crash on a malformed DB row.
  return { ok: false, needsRehash: false };
}
