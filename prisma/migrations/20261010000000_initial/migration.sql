-- CreateEnum
CREATE TYPE "RoomKind" AS ENUM ('PODCAST', 'SELF_RECORD');

-- CreateEnum
CREATE TYPE "RoomMemberRole" AS ENUM ('PARTICIPANT');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL,
    "room_owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RoomKind" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_members" (
    "room_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "RoomMemberRole" NOT NULL DEFAULT 'PARTICIPANT',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_members_pkey" PRIMARY KEY ("room_id","user_id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "link" TEXT,
    "storage_path" TEXT,
    "mime_type" TEXT,
    "byte_size" BIGINT,
    "sha256" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "frames" (
    "id" UUID NOT NULL,
    "video_id" UUID NOT NULL,
    "link" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "frames_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "inviter_id" UUID NOT NULL,
    "invited_id" UUID,
    "invited_email" TEXT NOT NULL,
    "room_id" UUID NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "rooms_room_owner_id_created_at_idx" ON "rooms"("room_owner_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "rooms_closed_at_idx" ON "rooms"("closed_at");

-- CreateIndex
CREATE INDEX "room_members_user_id_joined_at_idx" ON "room_members"("user_id", "joined_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "videos_room_id_key" ON "videos"("room_id");

-- CreateIndex
CREATE INDEX "videos_completed_at_idx" ON "videos"("completed_at" DESC);

-- CreateIndex
CREATE INDEX "frames_video_id_created_at_idx" ON "frames"("video_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invites_invited_email_status_created_at_idx" ON "invites"("invited_email", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "invites_inviter_id_created_at_idx" ON "invites"("inviter_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "invites_room_id_invited_email_key" ON "invites"("room_id", "invited_email");

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_room_owner_id_fkey" FOREIGN KEY ("room_owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "frames" ADD CONSTRAINT "frames_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_invited_id_fkey" FOREIGN KEY ("invited_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
