import { z } from "zod";

const passwordSchema = z
  .string()
  .min(8)
  .max(15)
  .regex(/^(?=.*[A-Z]).{8,}$/, {
    message: "Should contain minimum 1 upper case and minimum length 8"
  });

const requiredTrimmedRoomName = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    return value.trim();
  },
  z.string().min(1, "Room name is required").max(80, "Room name must be at most 80 characters")
);

export const SignupSchema = z.object({
  emailId: z.string().email().toLowerCase(),
  password: passwordSchema,
  name: z.string().min(1),
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, {
    message: "Username can only contain letters, numbers and underscores"
  })
});

export const LoginSchema = z.object({
  emailId: z.string().email().toLowerCase(),
  password: passwordSchema
});

export const CreateRoomSchema = z.object({
  RoomName: requiredTrimmedRoomName,
  kind: z.enum(["podcast", "self-record"]).optional()
});

export const InviteSchema = z.object({
  emailId: z.string().email().toLowerCase(),
  roomId: z.string().uuid()
});

export const ChunkSchema = z.object({
  recordingId: z.string().min(8).max(120),
  roomId: z.string().uuid(),
  chunkIndex: z.coerce.number().int().min(0),
  totalChunks: z.coerce.number().int().min(1).max(10000),
  sha256: z.string().length(64).optional()
});

export const CompleteRecordingSchema = z.object({
  recordingId: z.string().min(8).max(120),
  roomId: z.string().uuid(),
  totalChunks: z.coerce.number().int().min(1).max(10000)
});

export const FrameUploadSchema = z.object({
  roomId: z.string().uuid(),
  videoId: z.string().uuid(),
  recordingId: z.string().min(8).max(120)
});
