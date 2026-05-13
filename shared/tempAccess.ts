/**
 * TEMPORARY ACCESS GRANT — REMOVE BY 2026-05-18
 *
 * Grants the listed user IDs read/write access to /admin/destination-templates
 * (and its tRPC procedures) so they can onboard affiliate offers on behalf of
 * the owner during a 5-day window starting 2026-05-13.
 *
 * To revert: `git revert` the commit that introduced this file; no DB or
 * schema changes are involved.
 */
export const TEMPLATE_EDITOR_USER_IDS: ReadonlySet<number> = new Set([1893798]);

export function canManageTemplates(
  user: { id: number; role: string } | null | undefined,
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return TEMPLATE_EDITOR_USER_IDS.has(user.id);
}
