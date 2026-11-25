// Read-only public-relay benchmark, intentionally outside the regular test suite.
// No .env, cache relay, KV, HTTP server, signing or publishing is involved.
import { EventStore } from "applesauce-core";
import type { Filter } from "applesauce-core/helpers";
import { RelayPool } from "applesauce-relay";
import { fromEvent, lastValueFrom, reduce, takeUntil, tap } from "rxjs";
import {
  createNsiteSync,
  NSITE_SYNC_FILTERS,
  SITE_MANIFEST_KINDS,
} from "../../helpers/nsite-sync.ts";
import { buildIndexedSites } from "../../helpers/site-index.ts";

const relays: string[] = [];
let runs = 3;
let deadline = 120_000;
let timeout = 15_000;
for (const arg of Deno.args) {
  if (arg.startsWith("--runs=")) runs = Number(arg.slice(7));
  else if (arg.startsWith("--deadline=")) deadline = Number(arg.slice(11));
  else if (arg.startsWith("--timeout=")) timeout = Number(arg.slice(10));
  else if (/^wss?:\/\//.test(arg)) relays.push(new URL(arg).href);
  else throw new Error(`Unknown argument: ${arg}`);
}
if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
  throw new Error("--runs must be an integer from 1 to 10");
}
for (const value of [deadline, timeout]) {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("Timeouts must be positive finite milliseconds");
  }
}
if (relays.length === 0) {
  // Public NOSTR_RELAYS from .env.example, not the metadata-only LOOKUP_RELAYS.
  relays.push(
    "wss://relay.damus.io/",
    "wss://relay.primal.net/",
    "wss://relay.ditto.pub/",
  );
}
const until = Math.floor(Date.now() / 1000);
console.log(JSON.stringify({ relays, runs, deadline, timeout, until }));

async function measure(method: "legacy" | "sync", trial: number) {
  // A new pool and empty store for every measurement: do not give the new
  // implementation a warmed NIP-11 cache or a pre-hydrated event store.
  const pool = new RelayPool();
  const eventStore = new EventStore();
  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), deadline);
  let firstManifestMs: number | null = null;
  const accepted = new Set<string>();
  const inserts = eventStore.insert$.subscribe((event) => {
    accepted.add(event.id);
    if (SITE_MANIFEST_KINDS.includes(event.kind) && firstManifestMs === null) {
      firstManifestMs = performance.now() - started;
    }
  });
  let syncResult;
  let error;
  try {
    if (method === "legacy") {
      // Reproduce the old sequential, single-REQ hydration, only adding the
      // shared until bound so both methods query the same historical window.
      const request = (filter: Filter) => {
        controller.signal.throwIfAborted();
        return lastValueFrom(
          pool.request(relays, { ...filter, until }).pipe(
            takeUntil(fromEvent(controller.signal, "abort")),
            tap((event) => eventStore.add(event)),
            reduce((count) => count + 1, 0),
          ),
        );
      };
      await request(NSITE_SYNC_FILTERS.manifests);
      await request(NSITE_SYNC_FILTERS.deletes);
    } else {
      syncResult = await createNsiteSync({ eventStore, pool })(relays, {
        until,
        timeout,
        signal: controller.signal,
      });
    }
  } catch (cause) {
    error = String(cause);
  }
  const elapsedMs = performance.now() - started;
  const manifests = eventStore.getTimeline({ kinds: SITE_MANIFEST_KINDS });
  const sites = buildIndexedSites(manifests);
  const report = {
    trial,
    method,
    elapsedMs: Math.round(elapsedMs),
    firstManifestMs: firstManifestMs === null
      ? null
      : Math.round(firstManifestMs),
    deadlineExceeded: controller.signal.aborted,
    error,
    acceptedEvents: accepted.size,
    retainedManifests: manifests.length,
    manifestKinds: Object.fromEntries(
      SITE_MANIFEST_KINDS.map((kind) => [
        kind,
        manifests.filter((event) => event.kind === kind).length,
      ]),
    ),
    sites: sites.length,
    authors: new Set(sites.map((site) => site.pubkey)).size,
    complete: syncResult?.complete ?? null,
    statuses: syncResult?.statuses,
  };
  console.log(
    JSON.stringify(
      report,
      (_key, value) =>
        value instanceof Error
          ? { name: value.name, message: value.message }
          : value,
    ),
  );
  clearTimeout(timer);
  inserts.unsubscribe();
  for (const [, relay] of pool.relays) relay.close();
  eventStore.dispose();
  return {
    report,
    ids: new Set(manifests.map((event) => event.id)),
    sites: new Set(sites.map((site) => site.key)),
  };
}

const reports = [];
for (let trial = 1; trial <= runs; trial++) {
  // Alternate ordering to reduce bias from changing network/relay conditions.
  const order = trial % 2
    ? ["legacy", "sync"] as const
    : ["sync", "legacy"] as const;
  const results = [];
  for (const method of order) results.push(await measure(method, trial));
  const legacy = results.find((result) => result.report.method === "legacy")!;
  const sync = results.find((result) => result.report.method === "sync")!;
  console.log(JSON.stringify({
    comparison: trial,
    additionalManifests: [...sync.ids].filter((id) =>
      !legacy.ids.has(id)
    ).length,
    missingManifests: [...legacy.ids].filter((id) => !sync.ids.has(id)).length,
    additionalSites: [...sync.sites].filter((key) =>
      !legacy.sites.has(key)
    ).length,
    missingSites: [...legacy.sites].filter((key) =>
      !sync.sites.has(key)
    ).length,
  }));
  reports.push(...results.map((result) => result.report));
}
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
for (const method of ["legacy", "sync"]) {
  const measurements = reports.filter((report) => report.method === method);
  console.log(JSON.stringify({
    summary: method,
    runs: measurements.length,
    successfulRuns: measurements.filter((report) =>
      !report.error && !report.deadlineExceeded &&
      (method === "legacy" || report.complete)
    ).length,
    // Legacy completion is not evidence of exhaustive relay coverage.
    medianElapsedMs: median(measurements.map((report) =>
      report.elapsedMs
    )),
    medianSites: median(measurements.map((report) => report.sites)),
    medianManifests: median(
      measurements.map((report) => report.retainedManifests),
    ),
  }));
}
