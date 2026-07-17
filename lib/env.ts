export function getEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getOptionalEnv(name: string) {
  return process.env[name] || undefined;
}

export function getAppUrl() {
  return getEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000").replace(/\/$/, "");
}
