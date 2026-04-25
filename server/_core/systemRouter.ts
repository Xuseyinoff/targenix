import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./trpc";
import { isMultiDestinationsEnabled } from "../services/featureFlags";

export const systemRouter = router({
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      return {
        success: delivered,
      } as const;
    }),

  /**
   * Returns the feature-flag bundle for the authenticated user. The client uses
   * it to gate experimental UI (e.g. the v2 integration wizard at
   * /integrations/new-v2) without touching the environment variables. The
   * decision lives on the server so flipping a user off is a single env
   * change — no cache invalidation or client rebuild needed.
   */
  featureFlags: protectedProcedure.query(({ ctx }) => {
    return {
      multiDestinations: isMultiDestinationsEnabled(ctx.user.id),
      connectionSecretsOnly: true as const,
    };
  }),
});
