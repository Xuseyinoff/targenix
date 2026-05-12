/**
 * One-off: replace `templateType:` → `appKey:` and `payload.templateType`
 * → `payload.appKey` in the createPayload test file. Source migrated to
 * the appKey discriminator (Phase 2 of templateType removal).
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = "client/src/components/destinations/createPayload.test.ts";
let s = readFileSync(path, "utf8");

// Replace assertion fields and discriminator narrowing.
//   templateType: "X"     → appKey: "X"   (inside expect().toEqual({...}) blocks)
//   payload.templateType  → payload.appKey
//   jsonPayload.templateType / formPayload.templateType / getPayload.* → .appKey
// Word-boundary matched so unrelated tokens stay safe.
s = s.replace(/\btemplateType:/g, "appKey:");
s = s.replace(/\b(\w+)\.templateType\b/g, "$1.appKey");

writeFileSync(path, s);
console.log("Updated createPayload.test.ts");
