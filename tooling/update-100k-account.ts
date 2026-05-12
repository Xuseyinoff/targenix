/**
 * crm_connections-dagi 100k akkauntni real credentials bilan almashtirish.
 * Login qilib, yangi token va profileId-ni saqlaydi.
 */

import "dotenv/config";
import axios from "axios";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { crmConnections } from "../drizzle/schema";
import { encrypt } from "../server/encryption";

const BASE = "https://api.100k.uz/api";
const PHONE = "+998996006103";
const PASSWORD = "Samandar-2003";

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Login
  const loginRes = await axios.post(
    `${BASE}/auth/sign-in`,
    { username: PHONE, phone: PHONE, password: PASSWORD },
    { timeout: 15_000 },
  );
  const token = loginRes.data?.data as string;
  if (!token) throw new Error("login failed: no token");

  const meRes = await axios.get(`${BASE}/users/getMe`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 15_000,
  });
  const profileId = String(meRes.data?.data?.id ?? "");
  const name = String(meRes.data?.data?.name ?? "100k");
  console.log(`Logged in: profileId=${profileId}, name=${name}`);

  // Update existing row (id=3 from inspect output)
  const [existing] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.platform, "100k"))
    .limit(1);

  if (!existing) {
    await db.insert(crmConnections).values({
      userId: 0,
      platform: "100k",
      displayName: name,
      phone: PHONE,
      passwordEncrypted: encrypt(PASSWORD),
      bearerTokenEncrypted: encrypt(token),
      platformUserId: profileId,
      status: "active",
      lastLoginAt: new Date(),
    });
    console.log("Inserted new 100k account row.");
  } else {
    await db
      .update(crmConnections)
      .set({
        phone: PHONE,
        displayName: name,
        passwordEncrypted: encrypt(PASSWORD),
        bearerTokenEncrypted: encrypt(token),
        platformUserId: profileId,
        status: "active",
        lastLoginAt: new Date(),
      })
      .where(eq(crmConnections.id, existing.id));
    console.log(`Updated row id=${existing.id} (was phone=${existing.phone}, profileId=${existing.platformUserId}).`);
  }

  process.exit(0);
}

void main().catch((e) => {
  console.error("xato:", e?.message ?? e);
  process.exit(1);
});
