export function shortId(value: string, length = 8): string {
  return value.length <= length ? value : value.slice(0, length);
}

export function formatAgeFromUnix(createdAt: number, now = Date.now()): string {
  const ageSeconds = Math.max(0, Math.floor(now / 1000) - createdAt);
  if (ageSeconds < 60) return `${ageSeconds}s`;

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m`;

  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h`;

  const ageDays = Math.floor(ageHours / 24);
  if (ageDays < 30) return `${ageDays}d`;

  const ageMonths = Math.floor(ageDays / 30);
  if (ageMonths < 12) return `${ageMonths}mo`;

  return `${Math.floor(ageDays / 365)}y`;
}

/** Absolute UTC date and time, e.g. 2026-11-25 14:02 */
export function formatDateTime(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Compact count, e.g. 950, 1.2k, 18k, 1.1M */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Short label for an npub, e.g. npub1abcde…wxyz */
export function shortenNpub(npub: string): string {
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}

/** Stable hue (0-359) derived from a hex pubkey for author chips */
export function getPubkeyHue(pubkey: string): number {
  return parseInt(pubkey.slice(0, 6), 16) % 360;
}

/** Renders daily counts as a unicode sparkline */
export function sparkline(values: number[]): string {
  const bars = "▁▂▃▄▅▆▇█";
  const max = Math.max(...values, 0);
  if (max === 0) return "▁".repeat(values.length);
  return values
    .map((v) => bars[Math.min(bars.length - 1, Math.round((v / max) * 7))])
    .join("");
}
