import { IncomingMessage } from "node:http";
import { getServersFromServerListEvent, USER_BLOSSOM_SERVER_LIST_KIND } from "blossom-client-sdk";

import { BLOSSOM_SERVERS, MAX_FILE_SIZE } from "./env.js";
import { makeRequestWithAbort } from "./helpers/http.js";
import pool from "./nostr.js";

export async function getUserBlossomServers(pubkey: string, relays: string[]) {
  const blossomServersEvent = await pool.get(relays, { kinds: [USER_BLOSSOM_SERVER_LIST_KIND], authors: [pubkey] });

  return blossomServersEvent ? getServersFromServerListEvent(blossomServersEvent).map((u) => u.toString()) : undefined;
}

/**
 * Downloads a file from multiple servers
 * @todo download the file to /tmp and verify it
 */
export function downloadFile(sha256: string, servers = BLOSSOM_SERVERS): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const controllers = new Map<string, AbortController>();

    // make all requests in parallel
    servers.forEach(async (server) => {
      const url = new URL(sha256, server);
      const controller = new AbortController();
      let res: IncomingMessage | undefined = undefined;
      controllers.set(server, controller);

      try {
        const response = await makeRequestWithAbort(url, controller);
        res = response;

        if (!response.statusCode) throw new Error("Missing headers or status code");

        const size = response.headers["content-length"];
        if (size && parseInt(size) > MAX_FILE_SIZE) throw new Error("File too large");

        if (response.statusCode >= 200 && response.statusCode < 300) {
          // cancel the other requests
          for (const [other, abort] of controllers) {
            if (other !== server) abort.abort();
          }

          controllers.delete(server);
          return resolve(response);
        }
      } catch (error) {
        controllers.delete(server);
        if (res) res.resume();
      }

      // reject if last
      if (controllers.size === 0) reject(new Error("Failed to find blob on servers"));
    });

    // reject if all servers don't respond in 30s
    setTimeout(() => {
      reject(new Error("Timeout"));
    }, 30_000);
  });
}
