import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");
const client = new PrismaClient();
await client.$disconnect();
require.resolve("tsx");

const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, HOSTNAME: "127.0.0.1" },
  stdio: "inherit"
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Web exited with ${server.exitCode}`);
    const response = await fetch("http://127.0.0.1:3000/api/health").catch(() => null);
    if (response?.ok) { ready = true; break; }
    await setTimeout(100);
  }
  assert.ok(ready, "web server starts");
  const icon = await fetch("http://127.0.0.1:3000/icon.png");
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\/png/);
  const bytes = new Uint8Array(await icon.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const page = await fetch("http://127.0.0.1:3000/signin");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /rel="icon"[^>]*href="\/icon\.png/);
  console.log("Runtime smoke check passed: web, favicon, Prisma, and signaling dependencies.");
} finally {
  server.kill("SIGTERM");
}
