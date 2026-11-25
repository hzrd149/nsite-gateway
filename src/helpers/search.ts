import type { Directory, DirectoryAuthor, DirectorySite } from "./directory.ts";

/** Longest query accepted; longer input is truncated */
export const MAX_QUERY_LENGTH = 64;
/** Most words used from a query */
const MAX_TOKENS = 6;
export const MAX_SITE_RESULTS = 50;
export const MAX_AUTHOR_RESULTS = 20;

export type SearchResults = {
  query: string;
  sites: DirectorySite[];
  authors: DirectoryAuthor[];
  /** True when more sites matched than are shown */
  moreSites: boolean;
};

/** Lowercases, collapses whitespace and truncates a raw query */
export function normalizeQuery(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

function tokenize(query: string): string[] {
  return [...new Set(query.split(/[\s/]+/).filter(Boolean))].slice(
    0,
    MAX_TOKENS,
  );
}

/** Scores one token against a name; 0 means no match */
function scoreToken(name: string, extra: string, token: string): number {
  const index = name.indexOf(token);
  if (index === 0) return 4;
  if (index > 0) {
    // Word start ("moon" in "sun and moon") beats mid-word
    return /[\s\-_.]/.test(name[index - 1]) ? 3 : 2;
  }
  return extra.includes(token) ? 1 : 0;
}

/**
 * Searches the in-memory directory. Every token must match. Work is a single
 * linear pass bounded by the directory size and MAX_TOKENS.
 */
export function searchDirectory(
  directory: Directory,
  rawQuery: string,
): SearchResults {
  const query = normalizeQuery(rawQuery);
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return { query, sites: [], authors: [], moreSites: false };
  }

  const scoredSites: { site: DirectorySite; score: number }[] = [];
  for (const site of directory.recent) {
    let score = 0;
    for (const token of tokens) {
      const s = scoreToken(site.searchName, site.searchExtra, token);
      if (s === 0) {
        score = 0;
        break;
      }
      score += s;
    }
    if (score === 0) continue;
    if (site.identifier === query || site.title?.toLowerCase() === query) {
      score += 10;
    }
    scoredSites.push({ site, score });
  }
  // directory.recent is newest first and sort is stable, so ties stay recent
  scoredSites.sort((a, b) =>
    b.score - a.score || b.site.recentHits - a.site.recentHits
  );

  const npubQuery = query.startsWith("npub1") && query.length >= 8;
  const scoredAuthors: { author: DirectoryAuthor; score: number }[] = [];
  for (const author of directory.authors.values()) {
    let score = 0;
    if (npubQuery) {
      if (author.npub.startsWith(query)) score = 10;
    } else {
      for (const token of tokens) {
        const s = scoreToken(author.searchName, "", token);
        if (s === 0) {
          score = 0;
          break;
        }
        score += s;
      }
      if (score > 0 && author.searchName === query) score += 10;
    }
    if (score > 0) scoredAuthors.push({ author, score });
  }
  scoredAuthors.sort((a, b) =>
    b.score - a.score ||
    b.author.recentHits - a.author.recentHits ||
    b.author.siteKeys.length - a.author.siteKeys.length
  );

  return {
    query,
    sites: scoredSites.slice(0, MAX_SITE_RESULTS).map((s) => s.site),
    authors: scoredAuthors.slice(0, MAX_AUTHOR_RESULTS).map((a) => a.author),
    moreSites: scoredSites.length > MAX_SITE_RESULTS,
  };
}
