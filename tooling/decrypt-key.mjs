import { createDecipheriv, createHash } from "crypto";

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) { console.error("ENCRYPTION_KEY not set"); process.exit(1); }

function getKey() {
  return createHash("sha256").update(ENCRYPTION_KEY).digest();
}

function decrypt(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

// Ruslan's encrypted api_key from target_websites id=60014
const ruslanEncrypted = "b25e62463e83ef4c7113d7331532546f:f9aebaeff4838032d801f76a0dd4b59af78ea5fb4908ffc271aa0573e8185032c50bc437784c27776c4889859aeb6707";

try {
  const ruslanKey = decrypt(ruslanEncrypted);
  console.log("Ruslan's decrypted API key:", ruslanKey);
  console.log("\nYour API key (plaintext):   9996:964c37745cbd3ff4b643becbd6b57f25");
  console.log("\nMatch:", ruslanKey === "9996:964c37745cbd3ff4b643becbd6b57f25" ? "YES — SAME KEY!" : "NO — different keys");
} catch (e) {
  console.error("Decrypt failed:", e.message);
}
