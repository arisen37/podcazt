export function getSignalingUrl(token: string) {
  const configured = process.env.NEXT_PUBLIC_SIGNALING_URL;
  const defaultUrl = process.env.NODE_ENV === "development"
    ? `ws://${window.location.hostname}:4000`
    : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
  const base = configured || defaultUrl;
  const url = new URL(base);
  url.searchParams.set("token", token);
  return url.toString();
}

export async function getRealtimeToken() {
  const response = await fetch("/api/realtime-token", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to authenticate realtime connection");
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error("Realtime token was not returned");
  return body.token;
}
