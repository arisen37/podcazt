import nodemailer from "nodemailer";
import { getAppUrl, getOptionalEnv } from "@/lib/env";

export async function sendInviteEmail(input: {
  to: string;
  inviterName: string;
  roomName: string;
  inviteId: string;
}) {
  const user = getOptionalEnv("GOOGLE_EMAIL");
  const pass = getOptionalEnv("GOOGLE_APP_PASSWORD");
  const fromName = getOptionalEnv("GOOGLE_FROM_NAME") ?? "Podcazt";

  if (!user || !pass) {
    return { sent: false, reason: "Google email credentials are not configured" };
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });

  const inviteUrl = `${getAppUrl()}/invite/${input.inviteId}`;
  await transporter.sendMail({
    from: `${fromName} <${user}>`,
    to: input.to,
    subject: `${input.inviterName} invited you to record on Podcazt`,
    text: `Join "${input.roomName}" using this invite link: ${inviteUrl}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5">
        <h2>You're invited to Podcazt</h2>
        <p>${input.inviterName} invited you to join <strong>${input.roomName}</strong>.</p>
        <p><a href="${inviteUrl}">Join recording room</a></p>
      </div>
    `
  });

  return { sent: true };
}
