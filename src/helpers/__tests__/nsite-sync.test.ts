import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { EventStore } from "applesauce-core";
import {
  type Filter,
  matchFilter,
  type NostrEvent,
} from "applesauce-core/helpers";
import type { SyncLoaderMethods } from "applesauce-loaders/loaders";
import { defer, from, Observable, of, throwError } from "rxjs";
import { createNsiteSync } from "../nsite-sync.ts";

function event(id: number, created_at = id): NostrEvent {
  return {
    id: id.toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    kind: 5128,
    created_at,
    content: "",
    tags: [],
    sig: "b".repeat(128),
  };
}

function fixture(events: Record<string, NostrEvent[]>, nip77 = false) {
  const eventStore = new EventStore({ verifyEvent: () => true });
  const requests: { relay: string; filter: Filter }[] = [];
  const syncs: { relay: string; filter: Filter }[] = [];
  const select = (relay: string, filter: Filter) =>
    (events[relay] ?? []).filter((event) => matchFilter(filter, event))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, filter.limit ?? Infinity);
  const methods: SyncLoaderMethods = {
    getSupported: () => Promise.resolve(nip77 ? [77] : []),
    getMaxLimit: () => Promise.resolve(2),
    request: (relay, filters) =>
      defer(() => {
        const filter = filters[0];
        requests.push({ relay, filter });
        return from(select(relay, filter));
      }),
    sync: (relay, filter) =>
      defer(() => {
        syncs.push({ relay, filter });
        return from(
          select(relay, filter).filter((e) => !eventStore.hasEvent(e.id))
            .map((event) => ({
              type: "received" as const,
              from: relay,
              event,
            })),
        );
      }),
  };
  return { eventStore, methods, requests, syncs };
}

Deno.test("nsite sync pages past relay caps and deduplicates multiple relays", async () => {
  const events = Array.from({ length: 7 }, (_, i) => event(i + 1));
  const f = fixture({ "wss://a/": events, "wss://b/": events });
  try {
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
    })(
      ["wss://a/", "wss://b/"],
      { until: 100 },
    );
    assertEquals(result.manifests, 7);
    assertEquals(result.deletes, 0);
    assert(result.complete);
    assert(f.requests.length > 4);
    assertEquals(f.eventStore.getTimeline({ kinds: [5128] }).length, 7);
    assertEquals(
      result.statuses.manifests.relays["wss://a/"].method,
      "request",
    );
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("NIP-77 reconciles full sets on repeat runs including old and same-second arrivals", async () => {
  const events = { "wss://a/": [event(1, 100)] };
  const f = fixture(events, true);
  try {
    const sync = createNsiteSync({ eventStore: f.eventStore, ...f.methods });
    const first = await sync(["wss://a/"], { until: 200 });
    assertEquals(first.manifests, 1);
    events["wss://a/"].push(event(2, 100), event(3, 1));
    const second = await sync(["wss://a/"], { until: 200 });
    assertEquals(second.manifests, 2);
    assertEquals(f.eventStore.getTimeline({ kinds: [5128] }).length, 3);
    assertEquals(f.requests.length, 0);
    assert(f.syncs.every(({ filter }) => filter.since === undefined));
    assert(f.syncs.every(({ filter }) => filter.until === 200));
    assertEquals(
      second.statuses.manifests.relays["wss://a/"].method,
      "negentropy",
    );
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("broken NIP-77 falls back and reports the reason", async () => {
  const f = fixture({ "wss://a/": [event(1)] }, true);
  try {
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
      sync: () => throwError(() => new Error("NEG-ERR")),
    })(["wss://a/"]);
    assert(result.complete);
    assertEquals(result.manifests, 1);
    const status = result.statuses.manifests.relays["wss://a/"];
    assertEquals(status.method, "request");
    assertEquals(status.fallbackReason?.message, "NEG-ERR");
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("saturated timestamp boundaries are partial, not successful coverage", async () => {
  const f = fixture({
    "wss://a/": [event(1, 100), event(2, 100), event(3, 100)],
  });
  try {
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
    })(
      ["wss://a/"],
    );
    assertEquals(result.complete, false);
    const status = result.statuses.manifests.relays["wss://a/"];
    assertEquals(status.state, "incomplete");
    assertEquals(status.incomplete?.timestamp, 100);
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("deletions retain the nsite scope and remove matching manifests", async () => {
  const manifest = event(1);
  const deletion = {
    ...event(2),
    kind: 5,
    tags: [["e", manifest.id], ["k", "5128"]],
  };
  const unrelated = { ...event(3), kind: 5, tags: [["k", "1"]] };
  const f = fixture({ "wss://a/": [manifest, deletion, unrelated] });
  try {
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
    })(
      ["wss://a/"],
    );
    assertEquals(result.deletes, 1);
    assertEquals(f.eventStore.getTimeline({ kinds: [5128] }).length, 0);
    assertEquals(f.eventStore.hasEvent(unrelated.id), false);
    assert(f.requests.some(({ filter }) =>
      filter.kinds?.[0] === 5 &&
      JSON.stringify(filter["#k"]) === '["15128","35128","5128"]'
    ));
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("one failed relay does not discard healthy relay results", async () => {
  const f = fixture({ "wss://a/": [event(1)] });
  try {
    const request = f.methods.request;
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
      request: (relay, filters, opts) =>
        relay === "wss://bad/"
          ? throwError(() => new Error("offline"))
          : request(relay, filters, opts),
    })(["wss://a/", "wss://bad/"]);
    assertEquals(result.manifests, 1);
    assertEquals(result.complete, false);
    assertEquals(result.statuses.manifests.relays["wss://bad/"].state, "error");
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("abort tears down both concurrent phases and rejects the run", async () => {
  const eventStore = new EventStore({ verifyEvent: () => true });
  const controller = new AbortController();
  let started = 0;
  let stopped = 0;
  const sync = createNsiteSync({
    eventStore,
    getSupported: () => of([]),
    getMaxLimit: () => of(2),
    request: () =>
      new Observable(() => {
        started++;
        if (started === 2) controller.abort();
        return () => stopped++;
      }),
    sync: () => {
      throw new Error("unexpected NIP-77");
    },
  });
  try {
    await assertRejects(() =>
      sync(["wss://a/"], { signal: controller.signal })
    );
    assertEquals(started, 2);
    assertEquals(stopped, 2);
    await assertRejects(() => sync([], { signal: controller.signal }));
  } finally {
    eventStore.dispose();
  }
});

Deno.test("empty relay sets settle without requests", async () => {
  const f = fixture({});
  try {
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
    })(
      [],
    );
    assert(result.complete);
    assertEquals(result.manifests, 0);
    assertEquals(result.deletes, 0);
    assertEquals(f.requests.length, 0);
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("stalled relays time out while healthy relays finish", async () => {
  const f = fixture({ "wss://a/": [event(1)] });
  let stopped = 0;
  try {
    const request = f.methods.request;
    const result = await createNsiteSync({
      eventStore: f.eventStore,
      ...f.methods,
      request: (relay, filters, opts) =>
        relay === "wss://stalled/"
          ? new Observable(() => () => stopped++)
          : request(relay, filters, opts),
    })(["wss://a/", "wss://stalled/"], { timeout: 20 });
    assertEquals(result.manifests, 1);
    assertEquals(result.complete, false);
    assertEquals(
      result.statuses.manifests.relays["wss://stalled/"].state,
      "error",
    );
    assertEquals(stopped, 2);
  } finally {
    f.eventStore.dispose();
  }
});

Deno.test("date bounds apply inclusively to manifests and deletions on both loading methods", async () => {
  for (const nip77 of [false, true]) {
    const events = [
      event(1, 9),
      event(2, 10),
      event(3, 20),
      event(4, 21),
      { ...event(5, 9), kind: 5, tags: [["k", "5128"]] },
      { ...event(6, 10), kind: 5, tags: [["k", "5128"]] },
      { ...event(7, 20), kind: 5, tags: [["k", "5128"]] },
      { ...event(8, 21), kind: 5, tags: [["k", "5128"]] },
    ];
    const f = fixture({ "wss://a/": events }, nip77);
    try {
      const result = await createNsiteSync({
        eventStore: f.eventStore,
        ...f.methods,
      })(["wss://a/"], { since: 10, until: 20 });
      assertEquals(result.manifests, 2);
      assertEquals(result.deletes, 2);
      assert(result.complete);
      const calls = nip77 ? f.syncs : f.requests;
      assert(
        calls.every(({ filter }) => filter.since === 10 && filter.until! <= 20),
      );
      assertEquals(
        f.eventStore.getTimeline({ kinds: [5128] }).map((e) => e.created_at),
        [20, 10],
      );
    } finally {
      f.eventStore.dispose();
    }
  }
});

Deno.test("total deadline cancels both phases even while events keep arriving", async () => {
  const eventStore = new EventStore({ verifyEvent: () => true });
  let stopped = 0;
  let nextId = 1;
  const sync = createNsiteSync({
    eventStore,
    getSupported: () => of([]),
    getMaxLimit: () => of(500),
    request: () =>
      new Observable<NostrEvent>((subscriber) => {
        const timer = setInterval(() => subscriber.next(event(nextId++, 1)), 5);
        return () => {
          clearInterval(timer);
          stopped++;
        };
      }),
    sync: () => {
      throw new Error("unexpected NIP-77");
    },
  });
  try {
    const error = await assertRejects(
      () => sync(["wss://a/"], { timeout: 100, totalTimeout: 40 }),
      DOMException,
      "total deadline",
    );
    assertEquals(error.name, "TimeoutError");
    assertEquals(stopped, 2);
    assert(eventStore.getTimeline({ kinds: [5128] }).length > 0);
  } finally {
    eventStore.dispose();
  }
});

Deno.test("invalid ranges and deadlines reject before starting relay work", async () => {
  const f = fixture({});
  const sync = createNsiteSync({ eventStore: f.eventStore, ...f.methods });
  try {
    for (
      const options of [
        { since: 20, until: 10 },
        { since: -1 },
        { since: 1.5 },
        { until: NaN },
        { totalTimeout: 0 },
        { totalTimeout: Infinity },
        { totalTimeout: 2_147_483_648 },
      ]
    ) {
      await assertRejects(() => sync(["wss://a/"], options), RangeError);
    }
    assertEquals(f.requests.length, 0);
    assertEquals(f.syncs.length, 0);
  } finally {
    f.eventStore.dispose();
  }
});
