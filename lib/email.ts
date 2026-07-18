import nodemailer from "nodemailer";
import { getAppUrl, getOptionalEnv } from "@/lib/env";

export async function sendInviteEmail(input: {
  to: string;
  inviterName: string;
  roomName: string;
  inviteId: string;
  requestOrigin?: string;
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

  const inviteUrl = `${getAppUrl(input.requestOrigin)}/invite/${encodeURIComponent(input.inviteId)}`;
  const escapeHtml = (value: string) =>
    value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character] as string);
  try {
    await transporter.sendMail({
      from: `${fromName} <${user}>`,
      to: input.to,
      subject: `${input.inviterName} invited you to record on Podcazt`,
      text: `Join "${input.roomName}" using this invite link: ${inviteUrl}`,
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>You're invited to Podcazt</h2>
          <p>${escapeHtml(input.inviterName)} invited you to join <strong>${escapeHtml(input.roomName)}</strong>.</p>
          <p><a href="${escapeHtml(inviteUrl)}">Join recording room</a></p>
        </div>
      `
    });
  } catch (error) {
    console.error("Invite email delivery failed", error);
    return { sent: false, reason: "Email delivery failed" };
  }

  return { sent: true };
}
