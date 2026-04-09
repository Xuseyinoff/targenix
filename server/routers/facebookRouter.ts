import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getFacebookConnections,
  createFacebookConnection,
  deleteFacebookConnection,
} from "../db";
import { encrypt } from "../encryption";

export const facebookRouter = router({
  listConnections: protectedProcedure.query(async ({ ctx }) => {
    const connections = await getFacebookConnections(ctx.user.id);
    // Mask access tokens before returning
    return connections.map((c) => ({
      ...c,
      accessToken: "***",
    }));
  }),

  createConnection: protectedProcedure
    .input(
      z.object({
        pageId: z.string().min(1),
        pageName: z.string().min(1),
        accessToken: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      // Prevent duplicate connections for the same page
      const existing = await getFacebookConnections(userId);
      if (existing.some((c) => c.pageId === input.pageId)) {
        throw new Error(
          `A connection for page ID "${input.pageId}" already exists. Remove it first before re-adding.`
        );
      }
      // Validate the token against Graph API before storing
      const { validatePageToken } = await import("../services/facebookService");
      const valid = await validatePageToken(input.pageId, input.accessToken);
      if (!valid) {
        throw new Error(
          "Invalid or expired Page Access Token. Please generate a new Long-Lived token."
        );
      }
      const encryptedToken = encrypt(input.accessToken);
      await createFacebookConnection({
        userId,
        pageId: input.pageId,
        pageName: input.pageName,
        accessToken: encryptedToken,
      });
      return { success: true };
    }),

  deleteConnection: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const connections = await getFacebookConnections(userId);
      const owned = connections.find((c) => c.id === input.id);
      if (!owned) throw new Error("Connection not found");
      await deleteFacebookConnection(input.id);
      return { success: true };
    }),

  webhookUrl: protectedProcedure.query(() => {
    let base = (process.env.APP_URL || "https://targenix.uz").replace(/\/+$/, "");
    base = base.replace(/\/api\/webhooks\/facebook.*$/, "");
    return {
      url: `${base}/api/webhooks/facebook`,
      verifyToken: process.env.FACEBOOK_VERIFY_TOKEN || "(set FACEBOOK_VERIFY_TOKEN env var)",
    };
  }),
});
