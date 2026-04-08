import type { User } from "../../drizzle/schema";

export type PublicUser = Pick<
  User,
  | "id"
  | "openId"
  | "name"
  | "email"
  | "loginMethod"
  | "role"
  | "createdAt"
  | "updatedAt"
  | "lastSignedIn"
>;

export function toPublicUser(user: User | null): PublicUser | null {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    openId: user.openId,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastSignedIn: user.lastSignedIn,
  };
}
