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

function normalizeAppUrl(value?: string) {
  if (!value) return undefined;

  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (process.env.NODE_ENV === "production" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function getAppUrl(requestOrigin?: string) {
  const appUrl =
    normalizeAppUrl(process.env.NEXT_PUBLIC_APP_URL) ??
    normalizeAppUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    normalizeAppUrl(process.env.VERCEL_URL) ??
    normalizeAppUrl(requestOrigin);

  if (appUrl) return appUrl;
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";

  throw new Error("Set NEXT_PUBLIC_APP_URL to the public HTTPS origin used by email links");
}
