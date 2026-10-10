import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const reference = (character: string) => `ghcr.io/arisen37/podcazt@${digest(character)}`;

type Fixture = {
  images: Record<string, string>;
  references: string[];
  rejectRemoval?: string;
  rejectListing?: boolean;
};

function runCleanup(overrides: Partial<Fixture> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "podcazt-image-cleanup-"));
  const fixture: Fixture = {
    images: {
      "podcazt:latest": digest("a"),
      "podcazt:rollback": digest("b"),
      "podcazt-web-1": digest("a"),
      "podcazt-signaling-1": digest("a"),
      [reference("a")]: digest("a"),
      [reference("b")]: digest("b"),
      [reference("c")]: digest("c"),
      [reference("d")]: digest("d"),
    },
    references: [reference("a"), reference("b"), reference("c")],
    ...overrides,
  };
  const log = join(directory, "calls.jsonl");
  writeFileSync(join(directory, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(join(directory, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.CLEANUP_FIXTURE, 'utf8'));
fs.appendFileSync(process.env.CLEANUP_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image' && args[1] === 'inspect' || args[0] === 'inspect') {
  const name = args[0] === 'image' ? args[2] : args[1];
  if (!(name in fixture.images)) process.exit(1);
  console.log(fixture.images[name]);
} else if (args[0] === 'image' && args[1] === 'ls') {
  if (fixture.rejectListing) process.exit(1);
  console.log(fixture.references.join('\\n'));
} else if (args[0] === 'image' && args[1] === 'rm' && args.length === 3) {
  if (args[2] === fixture.rejectRemoval) process.exit(1);
} else {
  console.error('Unexpected Docker operation', args);
  process.exit(2);
}
`, { mode: 0o755 });
  try {
    const result = spawnSync("bash", [resolve(__dirname, "../deploy/aws/cleanup-images.sh")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        CLEANUP_FIXTURE: join(directory, "fixture.json"),
        CLEANUP_LOG: log,
      },
      encoding: "utf8",
    });
    const calls: string[][] = existsSync(log)
      ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      : [];
    return { ...result, calls, removals: calls.filter((args) => args[1] === "rm") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("release cleanup retains current/rollback images and ignores unrelated or invalid references", () => {
  const result = runCleanup({ references: [
    reference("a"), reference("b"), reference("c"), reference("c"),
    `postgres@${digest("d")}`, `ghcr.io/arisen37/podcazt-other@${digest("d")}`,
    "ghcr.io/arisen37/podcazt@<none>",
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.removals, [["image", "rm", reference("c")]]);
});

test("release cleanup retains images still used by either application container", () => {
  const result = runCleanup({ images: {
    "podcazt:latest": digest("a"), "podcazt:rollback": digest("b"),
    "podcazt-web-1": digest("c"), "podcazt-signaling-1": digest("d"),
    [reference("c")]: digest("c"), [reference("d")]: digest("d"),
  }, references: [reference("c"), reference("d")] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.removals, []);
});

test("missing or invalid protected images stop cleanup before listing/removing images", () => {
  for (const invalid of [undefined, ""]) {
    const images: Record<string, string> = {
      "podcazt:latest": digest("a"), "podcazt-web-1": digest("a"), "podcazt-signaling-1": digest("a"),
    };
    if (invalid !== undefined) images["podcazt:rollback"] = invalid;
    const result = runCleanup({ images });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.removals, []);
    assert.ok(!result.calls.some((args) => args[1] === "ls"));
  }
});

test("failed image inventory stops cleanup without deleting anything", () => {
  const result = runCleanup({ rejectListing: true });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.removals, []);
});

test("Docker removal refusal is reported without force and other obsolete images are processed", () => {
  const result = runCleanup({ references: [reference("c"), reference("d")], rejectRemoval: reference("c") });
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.removals, [["image", "rm", reference("c")], ["image", "rm", reference("d")]]);
});
