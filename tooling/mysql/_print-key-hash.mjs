import crypto from "node:crypto";
const k = process.env.ENCRYPTION_KEY;
if (!k) {
  console.error("ENCRYPTION_KEY missing");
  process.exit(1);
}
console.log(crypto.createHash("sha256").update(k).digest("hex"));
