# Podcazt

Next.js + TypeScript recording app with Prisma/PostgreSQL, optional Supabase Storage, Redis-ready rate limiting/signaling, and a standalone Express/WebSocket signaling server for WebRTC negotiation.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `NEXT_PUBLIC_APP_URL` to the public HTTPS origin of the deployed app. This
   is used for invite links; localhost values are rejected in production.
3. Set `DATABASE_URL` to your PostgreSQL URL. For a serverless deployment using Supabase,
   use the transaction pooler URL (port `6543`) with
   `?pgbouncer=true&connection_limit=1` so Prisma does not use prepared statements.
4. Optional: configure Supabase Storage variables for final video upload.
5. Optional: configure Gmail variables for email invite delivery.
6. Install dependencies and initialize Prisma:

```bash
npm install
npm run db:push
npm run dev
```

Run signaling separately when adding real peer-to-peer WebRTC streams:

```bash
npm run dev:signal
```

## Notes

- Browser JavaScript cannot implement raw custom UDP. WebRTC handles UDP transport internally; this project provides a WebSocket signaling server for WebRTC offer/answer/ICE exchange.
- Recording upload is reliable and sequential: the browser stores chunks locally, hashes each chunk, uploads one chunk at a time, verifies the server hash, then requests final assembly.
# podcazt
