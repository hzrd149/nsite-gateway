const BOT_USER_AGENT =
  /bot|crawl|spider|slurp|scrap|archiver|preview|facebookexternalhit|headless|lighthouse|curl\/|wget\/|python|httpx|aiohttp|go-http-client|java\/|okhttp|axios|node-fetch|undici|libwww|deno\/|bun\//i;

/** True for automated clients that should not count as site visits */
export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  return BOT_USER_AGENT.test(userAgent);
}
