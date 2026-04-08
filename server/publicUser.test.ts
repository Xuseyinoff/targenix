import { describe, expect, it } from "vitest";
import { toPublicUser } from "./_core/publicUser";
import type { User } from "../drizzle/schema";

describe("toPublicUser", () => {
  it("removes sensitive fields before returning auth user data", () => {
    const user: User = {
      id: 1,
      openId: "email:test@example.com",
      name: "Test User",
      email: "test@example.com",
      passwordHash: "hashed-password",
      loginMethod: "email",
      role: "admin",
      telegramChatId: "12345",
      telegramUsername: "testuser",
      telegramConnectedAt: new Date("2026-04-01T00:00:00.000Z"),
      telegramConnectToken: "tg-connect-token",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      lastSignedIn: new Date("2026-04-01T00:00:00.000Z"),
    };

    const publicUser = toPublicUser(user);

    expect(publicUser).toEqual({
      id: 1,
      openId: "email:test@example.com",
      name: "Test User",
      email: "test@example.com",
      loginMethod: "email",
      role: "admin",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      lastSignedIn: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(publicUser).not.toHaveProperty("passwordHash");
    expect(publicUser).not.toHaveProperty("telegramConnectToken");
    expect(publicUser).not.toHaveProperty("telegramChatId");
  });
});
