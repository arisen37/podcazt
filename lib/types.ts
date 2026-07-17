export type User = {
  id: string;
  email: string;
  username: string;
  name: string;
  created_at: string;
};

export type Video = {
  id: string;
  owner_id: string;
  name: string;
  link: string | null;
  created_at: string;
};

export type Room = {
  id: string;
  room_owner_id: string;
  video_id: string;
  name: string;
  kind: "podcast" | "self-record";
  created_at: string;
  closed_at: string | null;
};

export type Invite = {
  id: string;
  inviter_id: string;
  invited_id: string | null;
  invited_email: string;
  room_id: string;
  status: "pending" | "accepted" | "declined";
  created_at: string;
};

export type SessionUser = {
  id: string;
  email: string;
  username: string;
  name: string;
};
