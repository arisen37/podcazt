import { spawn, type ChildProcess } from "node:child_process";

let active: ChildProcess | undefined;
let interrupted = false;
const interrupt = () => { interrupted = true; active?.kill("SIGTERM"); };
process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
function command(program: string, args: string[]) {
  return new Promise<void>((accept, reject) => {
    active = spawn(program, args, { stdio: "inherit", env: process.env });
    active.once("error", reject);
    active.once("exit", (code) => code === 0 ? accept() : reject(new Error(program + " exited with " + code)));
  });
}
async function main() {
  try {
    await command("docker", ["compose", "-f", "tests/metrics/compose.yaml", "up", "-d", "--wait"]);
    if (interrupted) return;
    await command("npm", ["run", "build"]);
    if (interrupted) return;
    await command(process.execPath, ["--env-file-if-exists=.env.metrics", "--import", "tsx", "tests/metrics/run.ts", ...process.argv.slice(2)]);
  } finally {
    // This project contains only temporary benchmark data; no app volumes are touched.
    await command("docker", ["compose", "-f", "tests/metrics/compose.yaml", "down"]);
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (interrupted) process.exitCode = 130;
  }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
