/** Parse seconds strictly: reject typos rather than silently running unbounded work. */
export function parseRelaySyncConfig(env: Record<string, string | undefined>) {
  const seconds = (name: string, fallback: number, allowZero = false) => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    const max = allowZero ? Number.MAX_SAFE_INTEGER : 2_147_483;
    if (
      (raw && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) ||
      value < (allowZero ? 0 : 1) || value > max
    ) {
      throw new Error(
        `${name} must be an integer in seconds between ${
          allowZero ? 0 : 1
        } and ${max}`,
      );
    }
    return value;
  };
  return {
    totalTimeoutMs: seconds("RELAY_SYNC_TIMEOUT", 120) * 1000,
    progressTimeoutMs: seconds("RELAY_SYNC_PROGRESS_TIMEOUT", 15) * 1000,
    lookbackSeconds: seconds("RELAY_SYNC_LOOKBACK", 0, true),
  };
}
