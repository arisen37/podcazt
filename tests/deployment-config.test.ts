import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { renderConfiguration } from "../deploy/lightsail/setup-config";

function fixture() {
  const source = resolve(__dirname, "../deploy/lightsail");
  const directory = mkdtempSync(join(tmpdir(), "podcazt-config-test-"));
  cpSync(join(source, "templates"), join(directory, "templates"), { recursive: true });
  const config = readFileSync(join(source, "config.env.example"), "utf8")
    .replace("studio.example.com", "studio.podcazt.test")
    .replace("turn.example.com", "turn.podcazt.test")
    .replace("AWS_ACCESS_KEY_ID=", "AWS_ACCESS_KEY_ID=test-key")
    .replace("AWS_SECRET_ACCESS_KEY=", "AWS_SECRET_ACCESS_KEY=test-secret");
  writeFileSync(join(directory, "config.env"), config);
  return directory;
}

test("deployment config renders safely and preserves generated secrets", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const message = renderConfiguration(directory, true);
  assert.ok(!message.includes("test-secret"));
  const runtimePath = join(directory, "runtime.env");
  const original = readFileSync(runtimePath, "utf8");
  assert.equal(statSync(runtimePath).mode & 0o777, 0o600);
  renderConfiguration(directory, true);
  assert.equal(readFileSync(runtimePath, "utf8"), original);
  for (const name of readdirSync(join(directory, "generated"))) {
    const content = readFileSync(join(directory, "generated", name), "utf8");
    assert.ok(!content.includes("@@"));
    if (name.endsWith(".json")) JSON.parse(content);
  }
  const cors = JSON.parse(readFileSync(join(directory, "generated/s3-cors.json"), "utf8"));
  assert.deepEqual(cors.CORSRules[0].AllowedOrigins, ["https://studio.podcazt.test"]);
  const policy = JSON.parse(readFileSync(join(directory, "generated/s3-policy.json"), "utf8"));
  assert.equal(policy.Statement[0].Resource, "arn:aws:s3:::your-globally-unique-podcazt-bucket");
  assert.deepEqual(policy.Statement[1].Resource, [
    "arn:aws:s3:::your-globally-unique-podcazt-bucket/recordings/*",
    "arn:aws:s3:::your-globally-unique-podcazt-bucket/backups/*"
  ]);
  const nginx = readFileSync(join(directory, "generated/nginx-https.conf"), "utf8");
  assert.ok(nginx.includes("proxy_set_header X-Forwarded-For $remote_addr"));
  assert.ok(nginx.includes("location = /ws"));
});

test("EC2 role config omits static credentials and rejects conflicting keys", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.env");
  const config = readFileSync(path, "utf8")
    .replace("AWS_AUTH_MODE=static", "AWS_AUTH_MODE=instance-role")
    .replace("AWS_ACCESS_KEY_ID=test-key", "AWS_ACCESS_KEY_ID=")
    .replace("AWS_SECRET_ACCESS_KEY=test-secret", "AWS_SECRET_ACCESS_KEY=");
  writeFileSync(path, config);
  renderConfiguration(directory, true);
  const runtime = readFileSync(join(directory, "runtime.env"), "utf8");
  assert.doesNotMatch(runtime, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN/);
  writeFileSync(path, readFileSync(path, "utf8").replace("AWS_ACCESS_KEY_ID=", "AWS_ACCESS_KEY_ID=test-key"));
  assert.throws(() => renderConfiguration(directory, true), /Leave AWS credential values empty/);
});

test("domain TLS allows no email and validates a supplied email", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.env");
  writeFileSync(path, readFileSync(path, "utf8").replace("ACME_EMAIL=you@example.com", "ACME_EMAIL="));
  renderConfiguration(directory, true);
  assert.match(readFileSync(join(directory, "runtime.env"), "utf8"), /NEXT_PUBLIC_APP_URL='https:\/\/studio\.podcazt\.test'/);
  writeFileSync(path, readFileSync(path, "utf8").replace("ACME_EMAIL=", "ACME_EMAIL=invalid"));
  assert.throws(() => renderConfiguration(directory, true), /valid ACME_EMAIL/);
});

test("IP TLS renders matching HTTPS, TURN and CORS hosts without an email", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.env");
  writeFileSync(path, readFileSync(path, "utf8")
    .replace("TLS_MODE=domain", "TLS_MODE=ip")
    .replace("studio.podcazt.test", "203.0.113.10")
    .replace("turn.podcazt.test", "203.0.113.10")
    .replace("ACME_EMAIL=you@example.com", "ACME_EMAIL="));
  renderConfiguration(directory, true);
  const runtime = readFileSync(join(directory, "runtime.env"), "utf8");
  assert.match(runtime, /NEXT_PUBLIC_APP_URL='https:\/\/203\.0\.113\.10'/);
  assert.match(runtime, /TURN_HOST='203\.0\.113\.10'/);
  const nginx = readFileSync(join(directory, "generated/nginx-https.conf"), "utf8");
  assert.match(nginx, /server_name 203\.0\.113\.10;/);
  assert.match(nginx, /live\/203\.0\.113\.10\/fullchain.pem/);
  const cors = JSON.parse(readFileSync(join(directory, "generated/s3-cors.json"), "utf8"));
  assert.deepEqual(cors.CORSRules[0].AllowedOrigins, ["https://203.0.113.10"]);
  writeFileSync(path, readFileSync(path, "utf8").replace("TURN_DOMAIN=203.0.113.10", "TURN_DOMAIN=203.0.113.11"));
  assert.throws(() => renderConfiguration(directory, true), /set APP_DOMAIN and TURN_DOMAIN to PUBLIC_IP/);
});

test("deployment config rejects example domains without writing output", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.env");
  writeFileSync(path, readFileSync(path, "utf8").replace("studio.podcazt.test", "studio.example.com"));
  assert.throws(() => renderConfiguration(directory, true), /Replace the example/);
  assert.equal(existsSync(join(directory, "runtime.env")), false);
});

test("deployment config rejects invalid hostnames and shell expressions", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "config.env");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("studio.podcazt.test", "studio.test;evil"));
  assert.throws(() => renderConfiguration(directory, true), /Set a valid APP_DOMAIN/);
  writeFileSync(path, original.replace("test-secret", "test$secret"));
  assert.throws(() => renderConfiguration(directory, true), /dollar signs/);
});

test("TypeScript config CLI accepts a mounted configuration directory", (t) => {
  const directory = fixture();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [
    "--import", "tsx", resolve(__dirname, "../deploy/lightsail/setup-config.ts"),
    "--config-dir", directory, "--write"
  ], { encoding: "utf8" });
  assert.ok(output.includes("Generated configuration"));
  assert.ok(!output.includes("test-secret"));
  assert.equal(existsSync(join(directory, "runtime.env")), true);
});
