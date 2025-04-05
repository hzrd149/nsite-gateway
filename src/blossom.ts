import { IncomingMessage } from "node:http";

import { MAX_FILE_SIZE } from "./env.js";
import { makeRequestWithAbort } from "./helpers/http.js";
import { blobURLs } from "./cache.js";
import logger from "./logger.js";

const log = logger.extend("blossom");

/** Checks all servers for a blob and returns the URLs */
export async function findBlobURLs(sha256: string, servers: string[]): Promise<string[]> {
  const cache = await blobURLs.get(sha256);
  if (cache) return cache;

  const urls = await Promise.all(
    servers.map(async (server) => {
      const url = new URL(sha256, server);

      const check = await fetch(url, { method: "HEAD" }).catch(() => null);
      if (check?.status === 200) return url.toString();
      else return null;
    }),
  );

  const filtered = urls.filter((url) => url !== null);

  log(`Found ${filtered.length}/${servers.length} URLs for ${sha256}`);
  await blobURLs.set(sha256, filtered);
  return filtered;
}

/** Downloads a file from multiple servers */
export async function streamBlob(sha256: string, servers: string[]): Promise<IncomingMessage | undefined> {
  if (servers.length === 0) return undefined;

  // First find all available URLs
  const urls = await findBlobURLs(sha256, servers);
  if (urls.length === 0) return undefined;

  // Try each URL sequentially with timeout
  for (const urlString of urls) {
    const controller = new AbortController();
    let res: IncomingMessage | undefined = undefined;

    try {
      // Set up timeout to abort after 10s
      const timeout = setTimeout(() => {
        controller.abort();
      }, 10_000);

      const url = new URL(urlString);
      const response = await makeRequestWithAbort(url, controller);
      res = response;
      clearTimeout(timeout);

      if (!response.statusCode) throw new Error("Missing headers or status code");

      const size = response.headers["content-length"];
      if (size && parseInt(size) > MAX_FILE_SIZE) throw new Error("File too large");

      if (response.statusCode >= 200 && response.statusCode < 300) return response;
    } catch (error) {
      if (res) res.resume();
      continue; // Try next URL if this one fails
    }
  }
}
