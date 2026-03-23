export function createStrongEtag(value: string): string {
  return `"${value}"`;
}

function normalizeEtag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

export function hasMatchingIfNoneMatch(
  headers: Pick<Headers, "get">,
  etag: string,
): boolean {
  const ifNoneMatch = headers.get("if-none-match");
  if (!ifNoneMatch) return false;
  if (headers.get("range")) return false;
  if (ifNoneMatch.trim() === "*") return true;

  const expected = normalizeEtag(etag);
  return ifNoneMatch.split(",").some((candidate) => {
    return normalizeEtag(candidate) === expected;
  });
}

export function createWeakFileEtag(stat: Deno.FileInfo): string | undefined {
  if (!stat.mtime) return undefined;
  return `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
}
