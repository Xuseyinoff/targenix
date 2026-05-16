import { and, eq, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { MySqlTable, AnyMySqlColumn } from "drizzle-orm/mysql-core";
import type { DbClient } from "../db";

/**
 * Shape of a tenant-scoped table — must have integer `id` and `userId`
 * columns. Every per-tenant Drizzle table in this codebase matches
 * (triggers, workflows, integrations, destinations, leads, orders, …).
 */
type TenantScopedTable = MySqlTable & {
  id: AnyMySqlColumn;
  userId: AnyMySqlColumn;
};

/**
 * Returns a WHERE clause that scopes a query to `(id = X AND userId = Y)`.
 *
 * Use this in every UPDATE/DELETE on a tenant-scoped table — defense in
 * depth against a future caller that drops the prior SELECT ownership
 * check, against TOCTOU windows on rows that can change ownership, and
 * against accidental copy/paste of the row-id-only pattern.
 *
 * Example:
 *   await db.update(triggers)
 *     .set({ name: input.name })
 *     .where(ownedBy(triggers, input.id, ctx.user.id));
 */
export function ownedBy<T extends TenantScopedTable>(
  table: T,
  id: number,
  userId: number,
): SQL {
  return and(eq(table.id, id), eq(table.userId, userId))!;
}

/**
 * Throws TRPCError FORBIDDEN if the (id, userId) row does not exist.
 *
 * Use when a router needs to read-then-write and wants an explicit
 * tenant guard at the read step. Most existing routers already do the
 * SELECT-then-throw pattern by hand — this helper standardises it
 * across new code so future contributors don't have to reinvent it.
 *
 * The error message is intentionally generic ("Resource not found or
 * access denied") so it does not leak whether the id belongs to another
 * tenant or does not exist at all.
 */
export async function assertUserOwns<T extends TenantScopedTable>(
  db: DbClient,
  table: T,
  id: number,
  userId: number,
): Promise<void> {
  const rows = await db
    .select({ _: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.userId, userId)))
    .limit(1);
  if (rows.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Resource not found or access denied",
    });
  }
}
