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
