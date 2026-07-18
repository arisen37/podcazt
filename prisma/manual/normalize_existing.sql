BEGIN;

-- Replace Prisma's implicit room-user relation with a named, indexed membership table.
CREATE TYPE "RoomMemberRole" AS ENUM ('PARTICIPANT');

CREATE TABLE "room_members" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "RoomMemberRole" NOT NULL DEFAULT 'PARTICIPANT',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "room_members_pkey" PRIMARY KEY ("room_id", "user_id"),
    CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Preserve existing membership data created by Prisma's implicit many-to-many table.
INSERT INTO "room_members" ("room_id", "user_id")
SELECT "A", "B" FROM "_RoomMembers"
ON CONFLICT ("room_id", "user_id") DO NOTHING;

-- Ownership is already represented by rooms.room_owner_id.
DELETE FROM "room_members" AS membership
USING "rooms" AS room
WHERE membership."room_id" = room."id" AND membership."user_id" = room."room_owner_id";

CREATE INDEX "room_members_user_id_joined_at_idx" ON "room_members"("user_id", "joined_at" DESC);

-- Make a recording belong to exactly one room and move content metadata onto the recording.
ALTER TABLE "videos" ADD COLUMN "room_id" UUID;
ALTER TABLE "videos" ADD COLUMN "storage_path" TEXT;
ALTER TABLE "videos" ADD COLUMN "mime_type" TEXT;
ALTER TABLE "videos" ADD COLUMN "byte_size" BIGINT;
ALTER TABLE "videos" ADD COLUMN "sha256" TEXT;
ALTER TABLE "videos" ADD COLUMN "completed_at" TIMESTAMP(3);

UPDATE "videos" AS video
SET "room_id" = room."id",
    "completed_at" = CASE WHEN video."link" IS NOT NULL THEN video."created_at" ELSE NULL END
FROM "rooms" AS room
WHERE room."video_id" = video."id";

ALTER TABLE "videos" ALTER COLUMN "room_id" SET NOT NULL;
ALTER TABLE "videos" ADD CONSTRAINT "videos_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "videos_room_id_key" ON "videos"("room_id");
CREATE INDEX "videos_completed_at_idx" ON "videos"("completed_at" DESC);

-- A room already owns the name and owner relationship, so remove those copies from videos.
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_video_id_fkey";
DROP INDEX "rooms_video_id_idx";
ALTER TABLE "rooms" DROP COLUMN "video_id";
ALTER TABLE "videos" DROP CONSTRAINT "videos_owner_id_fkey";
DROP INDEX "videos_owner_id_idx";
ALTER TABLE "videos" DROP COLUMN "owner_id";
ALTER TABLE "videos" DROP COLUMN "name";

-- Add query-shaped indexes and make one invite row represent one room/email pair.
ALTER TABLE "invites" ADD COLUMN "responded_at" TIMESTAMP(3);

-- Keep the newest row when old data contains repeated invites for the same room and email.
DELETE FROM "invites" AS older
USING "invites" AS newer
WHERE older."room_id" = newer."room_id"
  AND older."invited_email" = newer."invited_email"
  AND (older."created_at" < newer."created_at" OR (older."created_at" = newer."created_at" AND older."id" < newer."id"));

CREATE UNIQUE INDEX "invites_room_id_invited_email_key" ON "invites"("room_id", "invited_email");
DROP INDEX IF EXISTS "invites_invited_email_idx";
DROP INDEX IF EXISTS "invites_room_id_idx";
DROP INDEX IF EXISTS "rooms_room_owner_id_idx";
DROP INDEX IF EXISTS "frames_video_id_idx";
CREATE INDEX "invites_invited_email_status_created_at_idx" ON "invites"("invited_email", "status", "created_at" DESC);
CREATE INDEX "invites_inviter_id_created_at_idx" ON "invites"("inviter_id", "created_at" DESC);
CREATE INDEX "rooms_room_owner_id_created_at_idx" ON "rooms"("room_owner_id", "created_at" DESC);
CREATE INDEX "rooms_closed_at_idx" ON "rooms"("closed_at");
CREATE INDEX "frames_video_id_created_at_idx" ON "frames"("video_id", "created_at" DESC);

DROP TABLE "_RoomMembers";

COMMIT;
