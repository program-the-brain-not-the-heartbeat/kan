import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { env } from "next-runtime-env";
import { z } from "zod";

import type { dbClient } from "@kan/db/client";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import * as cardAttachmentRepo from "@kan/db/repository/cardAttachment.repo";
import * as cardCommentRepo from "@kan/db/repository/cardComment.repo";
import * as checklistRepo from "@kan/db/repository/checklist.repo";
import * as importRepo from "@kan/db/repository/import.repo";
import * as inviteLinkRepo from "@kan/db/repository/inviteLink.repo";
import * as labelRepo from "@kan/db/repository/label.repo";
import * as listRepo from "@kan/db/repository/list.repo";
import * as memberRepo from "@kan/db/repository/member.repo";
import * as userRepo from "@kan/db/repository/user.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";
import { createS3Client, getStorageDriver } from "@kan/shared/utils";

import {
  adminProtectedProcedure,
  createTRPCRouter,
  publicProcedure,
} from "../trpc";

const checkDatabaseConnection = async (db: dbClient) => {
  try {
    await db.execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
};

const checkStorageConnection = async () => {
  try {
    if (getStorageDriver() === "fs") {
      const storageDir = process.env.KAN_STORAGE_DIR;
      if (!storageDir) {
        return false;
      }

      const fs = await import("node:fs/promises");
      const path = await import("node:path");

      const uploadsRoot = path.resolve(storageDir, "uploads");
      await fs.mkdir(uploadsRoot, { recursive: true });
      await fs.access(uploadsRoot);
      return true;
    }

    // Check if S3 is configured
    if (
      !process.env.S3_ENDPOINT ||
      !process.env.S3_ACCESS_KEY_ID ||
      !process.env.S3_SECRET_ACCESS_KEY
    ) {
      // S3 is optional, so return true if not configured
      return true;
    }

    const client = createS3Client();
    const avatarBucketName = env("NEXT_PUBLIC_AVATAR_BUCKET_NAME");
    const attachmentsBucketName = env("NEXT_PUBLIC_ATTACHMENTS_BUCKET_NAME");

    await client.send(new HeadBucketCommand({ Bucket: avatarBucketName }));
    await client.send(new HeadBucketCommand({ Bucket: attachmentsBucketName }));

    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
};

export const healthRouter = createTRPCRouter({
  health: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/health",
        summary: "Health check",
        description:
          "Returns the health status of the application and its dependencies",
        tags: ["Health"],
        protect: false,
      },
    })
    .input(z.void())
    .output(
      z.object({
        status: z.enum(["ok", "error"]),
        database: z.enum(["ok", "error"]).optional(),
        storage: z.enum(["ok", "error", "not_configured"]).optional(),
      }),
    )
    .query(async ({ ctx }) => {
      const dbHealthy = await checkDatabaseConnection(ctx.db);
      const storageHealthy = await checkStorageConnection();
      const driver = getStorageDriver();
      const storageConfigured =
        driver === "fs"
          ? !!process.env.KAN_STORAGE_DIR
          : !!(
              process.env.S3_ENDPOINT &&
              process.env.S3_ACCESS_KEY_ID &&
              process.env.S3_SECRET_ACCESS_KEY
            );

      const database = dbHealthy ? "ok" : "error";
      const storage = !storageConfigured
        ? "not_configured"
        : storageHealthy
          ? "ok"
          : "error";

      // Overall status is "ok" only if database is healthy and (storage is not configured or storage is healthy)
      const status =
        dbHealthy && (!storageConfigured || storageHealthy) ? "ok" : "error";

      return {
        status,
        database,
        storage,
      };
    }),
  stats: adminProtectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/stats",
        summary: "Get statistics",
        description:
          "Returns statistics about the application (workspaces, users, cards, etc.)",
        tags: ["Health"],
        protect: true,
      },
    })
    .input(z.void())
    .output(
      z.object({
        users: z.number(),
        workspaces: z.number(),
        boards: z.number(),
        lists: z.number(),
        cards: z.number(),
        cardComments: z.number(),
        cardAttachments: z.number(),
        cardActivityLogs: z.number(),
        labels: z.number(),
        checklists: z.number(),
        checklistItems: z.number(),
        activeMembers: z.number(),
        activeInviteLinks: z.number(),
        imports: z.number(),
      }),
    )
    .query(async ({ ctx }) => {
      try {
        // Execute all count queries in parallel
        const [
          usersCount,
          workspacesCount,
          boardsCount,
          listsCount,
          cardsCount,
          cardCommentsCount,
          checklistItemsCount,
          checklistsCount,
          labelsCount,
          cardAttachmentsCount,
          cardActivitiesCount,
          activeMembersCount,
          activeInviteLinksCount,
          importsCount,
          cardActivityLogsCount,
        ] = await Promise.all([
          userRepo.getCount(ctx.db),
          workspaceRepo.getCount(ctx.db),
          boardRepo.getCount(ctx.db),
          listRepo.getCount(ctx.db),
          cardRepo.getCount(ctx.db),
          cardCommentRepo.getCount(ctx.db),
          checklistRepo.getCountItems(ctx.db),
          checklistRepo.getCount(ctx.db),
          labelRepo.getCount(ctx.db),
          cardAttachmentRepo.getCount(ctx.db),
          cardActivityRepo.getCount(ctx.db),
          memberRepo.getActiveCount(ctx.db),
          inviteLinkRepo.getActiveCount(ctx.db),
          importRepo.getCount(ctx.db),
          memberRepo.getActiveCount(ctx.db),
          cardActivityRepo.getCount(ctx.db),
        ]);

        return {
          users: usersCount,
          workspaces: workspacesCount,
          boards: boardsCount,
          lists: listsCount,
          cards: cardsCount,
          cardComments: cardCommentsCount,
          checklistItems: checklistItemsCount,
          checklists: checklistsCount,
          labels: labelsCount,
          cardAttachments: cardAttachmentsCount,
          cardActivities: cardActivitiesCount,
          activeMembers: activeMembersCount,
          activeInviteLinks: activeInviteLinksCount,
          imports: importsCount,
          cardActivityLogs: cardActivityLogsCount,
        };
      } catch (error) {
        throw new TRPCError({
          message: `Failed to retrieve statistics: ${error instanceof Error ? error.message : "Unknown error"}`,
          code: "INTERNAL_SERVER_ERROR",
        });
      }
    }),
});
