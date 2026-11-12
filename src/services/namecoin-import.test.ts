import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert";
import { npubEncode } from "applesauce-core/helpers";
import { expandImports, resolveNamecoinNode } from "./namecoin-import.ts";
import { resolveFromNamecoinValueAsync } from "./namecoin.ts";

const PK = "460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c";
const PK_M = "6cdebccabda1dfa058ab85352a79509b592b2bdfa0370325e28ec1cb4f18667d";
const PK_ALT_M =
  "aaaa000000000000000000000000000000000000000000000000000000000001";

type FakeLookup = (name: string) => Promise<string | undefined | null>;

function fakeLookupFrom(
  records: Record<string, string>,
  counts?: { calls: string[] },
): FakeLookup {
  return (name) => {
    counts?.calls.push(name);
    return Promise.resolve(records[name]);
  };
}

// ── Pure unit tests for expandImports ────────────────────────────────────

Deno.test("expandImports: no import key returns object unchanged", async () => {
  const obj = { ip: "1.2.3.4" };
  const calls: string[] = [];
  const expanded = await expandImports(obj, () => {
    calls.push("should-not-happen");
    return Promise.resolve(undefined);
  });
  assertEquals(expanded, obj);
  assertEquals(calls.length, 0); // zero extra I/O when no import key
});

Deno.test("expandImports: string shorthand merges imported items", async () => {
  const obj = { import: "d/lib", ip: "1.1.1.1" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({
        ip: "9.9.9.9",
        nostr: { names: { _: "abc" } },
      }),
    }),
  );
  assertEquals(expanded.ip, "1.1.1.1"); // importer wins
  const nostr = expanded.nostr as Record<string, unknown>;
  const names = nostr.names as Record<string, unknown>;
  assertEquals(names._, "abc");
  assertFalse("import" in expanded);
});

Deno.test('expandImports: array shorthand ["d/foo"] works', async () => {
  const obj = { import: ["d/lib"], local: "keep" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({ "d/lib": JSON.stringify({ extra: "from-lib" }) }),
  );
  assertEquals(expanded.local, "keep");
  assertEquals(expanded.extra, "from-lib");
});

Deno.test("expandImports: array of strings means separate imports", async () => {
  const obj = { import: ["d/lib", "relay"] };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({
        ip: "1.1.1.1",
        map: { relay: { ip: "7.7.7.7", tag: "not-selected" } },
      }),
      relay: JSON.stringify({ tag: "second-import" }),
    }),
  );
  assertEquals(expanded.ip, "1.1.1.1");
  assertEquals(expanded.tag, "second-import");
});

Deno.test("expandImports: canonical array-of-arrays processes each in order", async () => {
  const obj = { import: [["d/a"], ["d/b"]] };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/a": JSON.stringify({ ip: "10.0.0.1", tag: "from-a" }),
      "d/b": JSON.stringify({ ip: "10.0.0.2", extra: "from-b" }),
    }),
  );
  // The first import wins after the importer's own items.
  assertEquals(expanded.ip, "10.0.0.1");
  assertEquals(expanded.tag, "from-a");
  assertEquals(expanded.extra, "from-b");
});

Deno.test("expandImports: importer items take precedence over imported", async () => {
  const obj = { import: "d/lib", ip: "1.1.1.1", extra: "local" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({
        ip: "9.9.9.9",
        extra: "remote",
        "only-imported": "yes",
      }),
    }),
  );
  assertEquals(expanded.ip, "1.1.1.1");
  assertEquals(expanded.extra, "local");
  assertEquals(expanded["only-imported"], "yes");
});

Deno.test("expandImports: null in importer suppresses imported value", async () => {
  const obj = { import: "d/lib", ip: null };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({ ip: "9.9.9.9", other: "keep" }),
    }),
  );
  assert("ip" in expanded);
  assertEquals(expanded.ip, null);
  assertEquals(expanded.other, "keep");
});

Deno.test("expandImports: depth-4 recursion happy path", async () => {
  const obj = { import: "d/a" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/a": JSON.stringify({ import: "d/b", layer: "a" }),
      "d/b": JSON.stringify({ import: "d/c", layer: "b" }),
      "d/c": JSON.stringify({ import: "d/d", layer: "c" }),
      "d/d": JSON.stringify({ layer: "d", deep: "reached" }),
    }),
  );
  // Each layer overrides "layer" so the top sees "a".
  assertEquals(expanded.layer, "a");
  // "deep" only exists on d/d and survives to the top.
  assertEquals(expanded.deep, "reached");
});

Deno.test("expandImports: chain past the supported degree fails", async () => {
  const obj = { import: "d/a", local: "keep" };
  await assertRejects(() =>
    expandImports(
      obj,
      fakeLookupFrom({
        "d/a": JSON.stringify({ import: "d/b", tag: "from-a" }),
        "d/b": JSON.stringify({ tag: "from-b" }),
      }),
      1,
    )
  );
});

Deno.test("expandImports: unavailable lookup fails resolution", async () => {
  const obj = { import: "d/missing", local: "survives" };
  await assertRejects(() => expandImports(obj, () => Promise.resolve(null)));
});

Deno.test("expandImports: lookup transport failure fails resolution", async () => {
  const obj = { import: "d/error", local: "survives" };
  await assertRejects(() =>
    expandImports(obj, () => {
      throw new Error("simulated network failure");
    })
  );
});

Deno.test("expandImports: malformed JSON in import target fails", async () => {
  const obj = { import: "d/broken", local: "keep" };
  await assertRejects(() =>
    expandImports(
      obj,
      fakeLookupFrom({ "d/broken": "not valid json {{{" }),
    )
  );
});

Deno.test("expandImports: malformed import value fails", async () => {
  const obj = { import: 42, local: "keep" };
  await assertRejects(() =>
    expandImports(obj, () => Promise.resolve(undefined))
  );
});

Deno.test("expandImports: cycle A to B to A fails resolution", async () => {
  const obj = { import: "d/a", local: "top" };
  await assertRejects(() =>
    expandImports(
      obj,
      fakeLookupFrom({
        "d/a": JSON.stringify({ import: "d/b", fromA: "yes" }),
        "d/b": JSON.stringify({ import: "d/a", fromB: "yes" }),
      }),
    )
  );
});

Deno.test("expandImports: multi-label selector descends map tree DNS-order", async () => {
  // Selector "a.b" walks right-to-left: map.b, then map.a.
  const obj = { import: [["d/lib", "a.b"]] };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({
        map: { b: { map: { a: { value: "deep" } } } },
      }),
    }),
  );
  assertEquals(expanded.value, "deep");
});

Deno.test("expandImports: selector falls back to wildcard when exact label missing", async () => {
  const obj = { import: [["d/lib", "ghost"]] };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({ map: { "*": { value: "wildcard" } } }),
    }),
  );
  assertEquals(expanded.value, "wildcard");
});

Deno.test("expandImports: processes imported root before applying its selector", async () => {
  const expanded = await expandImports(
    { import: [["d/lib", "relay"]] },
    fakeLookupFrom({
      "d/lib": JSON.stringify({ import: "d/layout" }),
      "d/layout": JSON.stringify({
        map: { relay: { value: "imported-map-path" } },
      }),
    }),
  );
  assertEquals(expanded.value, "imported-map-path");
});

Deno.test("expandImports: map empty key supplies parent defaults only", async () => {
  const expanded = await expandImports(
    {
      local: "parent",
      map: { "": { local: "default", inherited: "yes" } },
    },
    fakeLookupFrom({}),
  );
  assertEquals(expanded.local, "parent");
  assertEquals(expanded.inherited, "yes");

  await assertRejects(() =>
    resolveNamecoinNode(
      {
        map: {
          "": { value: "not-a-child-fallback" },
          known: { value: "known" },
        },
      },
      ["unknown"],
      fakeLookupFrom({}),
    )
  );
});

Deno.test("resolveNamecoinNode: walks labels right to left without inheriting ancestor nostr", async () => {
  const root = {
    nostr: { pubkey: PK_ALT_M },
    map: {
      b: {
        map: {
          a: { nostr: { pubkey: PK } },
        },
      },
    },
  };
  const selected = await resolveNamecoinNode(
    root,
    ["a", "b"],
    fakeLookupFrom({}),
  );
  assertEquals(selected.nostr, { pubkey: PK });

  const withoutLeafIdentity = {
    nostr: { pubkey: PK_ALT_M },
    map: { www: {} },
  };
  const leaf = await resolveNamecoinNode(
    withoutLeafIdentity,
    ["www"],
    fakeLookupFrom({}),
  );
  assertEquals(leaf.nostr, undefined);
});

Deno.test("resolveNamecoinNode: processes imports inside a selected map child", async () => {
  const selected = await resolveNamecoinNode(
    {
      map: {
        b: { import: "d/child" },
      },
    },
    ["a", "b"],
    fakeLookupFrom({
      "d/child": JSON.stringify({
        map: { a: { nostr: { pubkey: PK } } },
      }),
    }),
  );
  assertEquals(selected.nostr, { pubkey: PK });
});

Deno.test("expandImports: attempts later imports but still returns the first failure", async () => {
  const counts = { calls: [] as string[] };
  await assertRejects(() =>
    expandImports(
      { import: ["d/missing", "d/available"] },
      fakeLookupFrom({
        "d/available": JSON.stringify({ nostr: { pubkey: PK } }),
      }, counts),
    )
  );
  assertEquals(counts.calls, ["d/missing", "d/available"]);
});

// ── Integration: resolveFromNamecoinValueAsync follows imports ───────────

Deno.test("resolveFromNamecoinValueAsync: follows import for nostr.names block", async () => {
  // The real-world testls.bit deployment: the apex `d/testls` is up
  // against the 520-byte per-name limit and delegates its `nostr.names`
  // block to a sibling via `"import":"dd/testls"`. Without import support
  // this would fail; with it, the bare and named NIP-05 forms both
  // resolve to the imported block.
  const counts = { calls: [] as string[] };
  const fetcher = fakeLookupFrom(
    {
      "dd/testls": JSON.stringify({
        nostr: {
          names: {
            _: PK,
            m: PK_M,
          },
        },
      }),
    },
    counts,
  );
  const apexRaw = JSON.stringify({
    import: "dd/testls",
    ip: "107.152.38.155",
  });

  const root = await resolveFromNamecoinValueAsync(apexRaw, fetcher);
  assertEquals(root, {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });

  // dd/testls fetched exactly once for the root resolution.
  assertEquals(counts.calls, ["dd/testls"]);
});

Deno.test("resolveFromNamecoinValueAsync: no-import record skips fetcher entirely", async () => {
  // Regression guard for the "zero extra cost" property of ifa-0001
  // import handling: non-import records must not invoke the fetcher.
  const counts = { calls: [] as string[] };
  const apexRaw = JSON.stringify({
    nostr: { names: { _: PK } },
  });
  const result = await resolveFromNamecoinValueAsync(
    apexRaw,
    fakeLookupFrom({}, counts),
  );
  assertEquals(result, {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
  assertEquals(counts.calls, []);
});

Deno.test("resolveFromNamecoinValueAsync: importer wins on nostr.names block", async () => {
  // Importer declares its own `nostr.names`; imported has a different
  // one. Importer wins on the whole `nostr` key (shallow merge per spec).
  const apexRaw = JSON.stringify({
    import: "dd/testls",
    nostr: { names: { m: PK_ALT_M } },
  });
  const fetcher = fakeLookupFrom({
    "dd/testls": JSON.stringify({
      nostr: { names: { m: PK_M } },
    }),
  });
  const result = await resolveFromNamecoinValueAsync(apexRaw, fetcher);
  // A single non-root names entry is deterministic and accepted.
  assertEquals(result, {
    type: "replaceable",
    pubkey: PK_ALT_M,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("resolveFromNamecoinValueAsync: walks a local map without imports", async () => {
  const rawValue = JSON.stringify({
    map: { www: { nostr: { nsite: npubEncode(PK) } } },
  });
  const resolved = await resolveFromNamecoinValueAsync(
    rawValue,
    () => Promise.reject(new Error("unexpected fetch")),
    ["www"],
  );
  assertEquals(resolved, {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("resolveFromNamecoinValueAsync: unrelated import failure preserves a pinned direct target", async () => {
  const rawValue = JSON.stringify({
    nostr: { nsite: npubEncode(PK) },
    import: "d/unrelated",
  });
  const resolved = await resolveFromNamecoinValueAsync(
    rawValue,
    () => Promise.resolve(undefined),
  );
  assertEquals(resolved, {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("resolveFromNamecoinValueAsync: import failure rejects a top-level direct alias", async () => {
  const rawValue = JSON.stringify({
    nsite: npubEncode(PK),
    import: "d/may-contain-nested-nsite",
  });
  await assertRejects(() =>
    resolveFromNamecoinValueAsync(
      rawValue,
      () => Promise.resolve(undefined),
    )
  );
});

Deno.test("resolveFromNamecoinValueAsync: failed import cannot produce a successful mapping", async () => {
  const apexRaw = JSON.stringify({
    import: "dd/missing",
    nostr: { names: { _: PK } },
  });
  await assertRejects(() =>
    resolveFromNamecoinValueAsync(
      apexRaw,
      () => Promise.resolve(undefined),
    )
  );
});
