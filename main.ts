#!/usr/bin/env -S deno run --unstable-kv --unstable-no-legacy-abort --allow-env --allow-net --allow-read --allow-write --allow-sys=uid

import {
  BLOSSOM_PROXY,
  BLOSSOM_SERVERS,
  CACHE_RELAYS,
  HOST,
  LOOKUP_RELAYS,
  NOSTR_RELAYS,
  NSITE_HOST,
  NSITE_PORT,
  RELAY_SYNC_CONFIG,
  RLEAY_SYNC_INTERVAL,
} from "./src/env.ts";
import app from "./src/server.ts";
import { onShutdown } from "./src/helpers/shutdown.ts";
import { verifiedBlobCache } from "./src/services/blossom.ts";
import { startCurationService } from "./src/services/curation.ts";
import { subscribeNsiteEvents, syncNsiteEvents } from "./src/services/nostr.ts";
import { logFields, logValue } from "./src/helpers/request-log.ts";

function formatList(values: string[] | undefined, empty = "none") {
  return values && values.length > 0 ? values.join(", ") : empty;
}

console.log(`Starting nsite gateway on http://${HOST}`);
console.log(`lookup relays: ${formatList(LOOKUP_RELAYS)}`);
console.log(`cache relays: ${formatList(CACHE_RELAYS)}`);
console.log(`nostr relays: ${formatList(NOSTR_RELAYS)}`);
console.log(
  `relay sync: total timeout ${
    RELAY_SYNC_CONFIG.totalTimeoutMs / 1000
  }s, progress timeout ${
    RELAY_SYNC_CONFIG.progressTimeoutMs / 1000
  }s, lookback ${
    RELAY_SYNC_CONFIG.lookbackSeconds > 0
      ? `${RELAY_SYNC_CONFIG.lookbackSeconds}s`
      : "all history"
  }`,
);
console.log(`blossom servers: ${formatList(BLOSSOM_SERVERS)}`);
console.log(`blossom proxy: ${BLOSSOM_PROXY || "none"}`);
console.log(
  `[nsite:disk-cache] limits ${logFields(verifiedBlobCache.options)}`,
);
const cacheMetricsTimer = setInterval(() => {
  console.log(
    `[nsite:disk-cache] metrics ${logFields(verifiedBlobCache.metrics)}`,
  );
}, 60_000);
onShutdown(() => {
  clearInterval(cacheMetricsTimer);
  return Promise.resolve();
});

const server = Deno.serve(
  {
    hostname: NSITE_HOST,
    port: NSITE_PORT,
    onListen({ hostname, port }) {
      console.log(`nsite gateway listening on http://${hostname}:${port}`);
    },
  },
  app.fetch,
);

startCurationService();

// Hydrate from nostr relays when set
if (NOSTR_RELAYS && NOSTR_RELAYS.length > 0) {
  // Use an inclusive shared boundary: live delivery covers events published during
  // historical hydration, without opening a second full-history subscription.
  const hydrationUntil = Math.floor(Date.now() / 1000);
  let syncInFlight = false;
  let stopped = false;
  const runSync = async (until?: number) => {
    if (syncInFlight || stopped) return;
    syncInFlight = true;
    try {
      const result = await syncNsiteEvents(NOSTR_RELAYS, { until });
      console.log(
        `Relay sync received ${result.manifests} unique manifest events and ${result.deletes} delete events in ${
          Math.round(result.elapsedMs)
        }ms (${result.complete ? "complete" : "partial"})`,
      );
      for (const [phase, status] of Object.entries(result.statuses)) {
        for (const relay of Object.values(status.relays)) {
          console.log(
            `  ${phase} ${relay.relay}: ${relay.state}, ${
              relay.method ?? "none"
            }, ${relay.count} events${
              relay.error ? `, ${relay.error.message}` : ""
            }${
              relay.incomplete
                ? `, incomplete second ${relay.incomplete.timestamp}`
                : ""
            }${
              relay.fallbackReason
                ? `, fallback: ${relay.fallbackReason.message}`
                : ""
            }`,
          );
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        console.warn(
          "Relay sync stopped at its total deadline; keeping loaded events",
          error.message,
        );
      } else if (
        !stopped &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) console.error(`Relay sync failed: ${logValue(error)}`);
    } finally {
      syncInFlight = false;
    }
  };
  onShutdown(() => {
    stopped = true;
    return Promise.resolve();
  });

  if (RLEAY_SYNC_INTERVAL === "live") {
    console.log("Live relay sync enabled");
    const liveSync = subscribeNsiteEvents(NOSTR_RELAYS, hydrationUntil);

    onShutdown(() => {
      liveSync.unsubscribe();
      return Promise.resolve();
    });
  } else {
    const syncTimer = setInterval(
      () => void runSync(),
      RLEAY_SYNC_INTERVAL * 1000,
    );

    onShutdown(() => {
      clearInterval(syncTimer);
      return Promise.resolve();
    });
  }
  console.log(`Hydrating from nostr relays: ${formatList(NOSTR_RELAYS)}`);
  void runSync(hydrationUntil);
}

onShutdown(async () => {
  console.log("nsite gateway shutting down...");
  await server.shutdown();
});
