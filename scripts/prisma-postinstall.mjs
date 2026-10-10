import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Docker installs packages before the schema is available. Normal installs still
// generate the client, using the same skip flag as @prisma/client's install hook.
if (!process.env.PRISMA_SKIP_POSTINSTALL_GENERATE) {
  const prisma = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  const result = spawnSync(process.execPath, [prisma, "generate"], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
