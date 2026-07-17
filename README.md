# Podcazt

Next.js + TypeScript recording app with Prisma/PostgreSQL, optional Supabase Storage, Redis-ready rate limiting/signaling, and a standalone Express/WebSocket signaling server for WebRTC negotiation.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `DATABASE_URL` to your PostgreSQL URL. A Supabase Postgres connection string works.
3. Optional: configure Supabase Storage variables for final video upload.
4. Optional: configure SMTP variables for email invite delivery.
5. Install dependencies and initialize Prisma:

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
