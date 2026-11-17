/** Blossom blob identifiers must never be interpreted as URLs or paths. */
export function isBlobHash(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 &&
    /^[0-9a-f]{64}$/.test(value);
}

/** Transport validation only; this does not enforce a public-network policy. */
export function parseBlossomURL(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

/** Follow Blossom redirects without letting fetch bypass URL validation. */
export async function fetchBlossom(
  source: string,
  init: { method?: string; headers?: HeadersInit; signal: AbortSignal },
): Promise<Response> {
  const method = init.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    throw new Error("Blossom requests must use GET or HEAD");
  }

  let target = source;
  for (let redirects = 0;; redirects++) {
    const url = parseBlossomURL(target);
    if (!url) throw new Error("Invalid Blossom URL");

    const response = await fetch(url, {
      ...init,
      method,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Blossom redirect is missing Location");
    if (redirects >= 5) throw new Error("Too many Blossom redirects");
    target = new URL(location, url).href;
  }
}

/** Ignore malformed server tags independently, preserving root normalization. */
export function getBlossomServers(tags: string[][]): string[] {
  const servers = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "server" || !tag[1]) continue;
    const url = parseBlossomURL(tag[1]);
    if (url) servers.add(new URL("/", url).toString());
  }
  return [...servers];
}
