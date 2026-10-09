import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join, resolve } from "node:path";

const secretNames = ["POSTGRES_PASSWORD", "SESSION_SECRET", "SIGNALING_INTERNAL_SECRET", "TURN_SHARED_SECRET"];

/** Render config without evaluating shell expressions or printing credentials. */
export function renderConfiguration(directory: string, write = false) {
  const configPath = join(directory, "config.env");
  const original = readFileSync(configPath, "utf8");
  const values: Record<string, string> = Object.create(null);
  for (const line of original.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Expected KEY=value in config.env");
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const tlsMode = values.TLS_MODE || "domain";
  if (!["domain", "ip"].includes(tlsMode)) throw new Error("TLS_MODE must be domain or ip");
  for (const name of ["PUBLIC_IP", "PRIVATE_IP"]) {
    if (!isIPv4(values[name] ?? "")) throw new Error(`Set a valid ${name}`);
  }
  if (tlsMode === "ip") {
    if (values.APP_DOMAIN !== values.PUBLIC_IP || values.TURN_DOMAIN !== values.PUBLIC_IP) {
      throw new Error("For IP TLS, set APP_DOMAIN and TURN_DOMAIN to PUBLIC_IP");
    }
  } else {
    for (const name of ["APP_DOMAIN", "TURN_DOMAIN"]) {
      const value = values[name] ?? "";
      if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value)) {
        throw new Error(`Set a valid ${name}`);
      }
      if (value === "example.com" || value.endsWith(".example.com")) throw new Error(`Replace the example ${name} with your domain`);
    }
    if (values.APP_DOMAIN === values.TURN_DOMAIN) throw new Error("Use a separate TURN subdomain");
  }
  values.TLS_SERVER_NAMES = tlsMode === "ip" ? values.PUBLIC_IP : `${values.APP_DOMAIN} ${values.TURN_DOMAIN}`;
  if ((values.ACME_EMAIL || tlsMode === "domain") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.ACME_EMAIL ?? "")) throw new Error("Set ACME_EMAIL");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.S3_BUCKET ?? "")) throw new Error("Set S3_BUCKET");
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(values.AWS_REGION ?? "")) throw new Error("Set AWS_REGION");
  const authMode = values.AWS_AUTH_MODE || "static";
  if (!["static", "instance-role"].includes(authMode)) throw new Error("AWS_AUTH_MODE must be static or instance-role");
  if (authMode === "static") {
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      if (!values[name]) throw new Error(`Set ${name} for the restricted S3 IAM user`);
    }
  } else if (values.AWS_ACCESS_KEY_ID || values.AWS_SECRET_ACCESS_KEY || values.AWS_SESSION_TOKEN) {
    throw new Error("Leave AWS credential values empty when using instance-role");
  }
  for (const name of secretNames) {
    values[name] ||= randomBytes(32).toString("hex");
    if (!/^[A-Za-z0-9_-]{32,}$/.test(values[name])) throw new Error(`${name} must have at least 32 URL-safe characters`);
  }
  if (Object.values(values).some((value) => /[$'\r\n]/.test(value))) {
    throw new Error("Config values cannot contain dollar signs, single quotes, or newlines");
  }
  const runtime: Record<string, string> = {
    NODE_ENV: "production", NEXT_PUBLIC_APP_URL: `https://${values.APP_DOMAIN}`,
    POSTGRES_USER: "podcazt", POSTGRES_DB: "podcazt", POSTGRES_PASSWORD: values.POSTGRES_PASSWORD,
    DATABASE_URL: `postgresql://podcazt:${values.POSTGRES_PASSWORD}@postgres:5432/podcazt?connection_limit=5`,
    REDIS_URL: "redis://redis:6379", SIGNALING_PORT: "4000", SINGLE_INSTANCE_SIGNALING: "true",
    SIGNALING_INTERNAL_URL: "http://signaling:4000", STORAGE_PROVIDER: "s3", TURN_HOST: values.TURN_DOMAIN
  };
  for (const name of ["AWS_REGION", "S3_BUCKET", "SESSION_SECRET",
    "SIGNALING_INTERNAL_SECRET", "TURN_SHARED_SECRET", "GOOGLE_EMAIL", "GOOGLE_APP_PASSWORD", "GOOGLE_FROM_NAME"]) {
    runtime[name] = values[name] ?? "";
  }
  if (authMode === "static") {
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
      if (values[name]) runtime[name] = values[name];
    }
  }
  const output = join(directory, "generated");
  const files = new Map<string, string>();
  for (const name of ["nginx-http.conf", "nginx-https.conf", "turnserver.conf", "renew-certificates.sh",
    "s3-cors.json", "s3-policy.json", "s3-lifecycle.json"]) {
    let content = readFileSync(join(directory, "templates", name), "utf8");
    for (const [key, value] of Object.entries(values)) content = content.replaceAll(`@@${key}@@`, value);
    if (content.includes("@@")) throw new Error(`Unresolved template value in ${name}`);
    files.set(join(output, name), content);
  }
  files.set(join(directory, "runtime.env"), Object.entries(runtime).map(([key, value]) => `${key}='${value}'\n`).join(""));
  if (write) {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    const lines = original.trimEnd().split(/\r?\n/).filter((line) =>
      !secretNames.some((name) => new RegExp(`^\\s*${name}\\s*=`).test(line))
    );
    for (const name of secretNames) lines.push(`${name}=${values[name]}`);
    files.set(configPath, lines.join("\n") + "\n");
    for (const [path, content] of files) {
      writeFileSync(path, content, { mode: 0o600 });
      chmodSync(path, 0o600);
    }
  }
  return write ? "Generated configuration. Keep config.env and runtime.env private."
    : "Configuration valid. Run with --write to generate files; secrets are not printed.";
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  try {
    const directoryIndex = process.argv.indexOf("--config-dir");
    const directory = directoryIndex < 0 ? __dirname : process.argv[directoryIndex + 1];
    if (!directory) throw new Error("--config-dir requires a directory");
    console.log(renderConfiguration(directory, process.argv.includes("--write")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuration generation failed");
    process.exitCode = 1;
  }
}
