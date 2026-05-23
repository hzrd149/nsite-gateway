import { assert, assertEquals, assertFalse } from "jsr:@std/assert";
import { expandImports } from "./namecoin-import.ts";
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

Deno.test("expandImports: pair-array shorthand uses selector", async () => {
  const obj = { import: ["d/lib", "relay"] };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({
        ip: "1.1.1.1",
        map: { relay: { ip: "7.7.7.7", tag: "selected" } },
      }),
    }),
  );
  // We descended into map.relay, so its contents are merged at top level.
  assertEquals(expanded.ip, "7.7.7.7");
  assertEquals(expanded.tag, "selected");
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
  // Later imports override earlier ones; importer has no own ip.
  assertEquals(expanded.ip, "10.0.0.2");
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

Deno.test("expandImports: chain past max-depth is silently truncated", async () => {
  const obj = { import: "d/a", local: "keep" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/a": JSON.stringify({ import: "d/b", tag: "from-a" }),
      "d/b": JSON.stringify({ tag: "from-b", leaf: "wont-show" }),
    }),
    1, // only one level of imports
  );
  assertEquals(expanded.tag, "from-a");
  assertEquals(expanded.local, "keep");
  assertFalse("leaf" in expanded);
});

Deno.test("expandImports: lookup returns null treated as empty object", async () => {
  const obj = { import: "d/missing", local: "survives" };
  const expanded = await expandImports(obj, () => Promise.resolve(null));
  assertEquals(expanded.local, "survives");
  assertFalse("import" in expanded);
});

Deno.test("expandImports: lookup that throws is treated as empty object", async () => {
  const obj = { import: "d/error", local: "survives" };
  const expanded = await expandImports(obj, () => {
    throw new Error("simulated network failure");
  });
  assertEquals(expanded.local, "survives");
  assertFalse("import" in expanded);
});

Deno.test("expandImports: malformed JSON in import target is skipped", async () => {
  const obj = { import: "d/broken", local: "keep" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({ "d/broken": "not valid json {{{" }),
  );
  assertEquals(expanded.local, "keep");
});

Deno.test("expandImports: malformed import value (number) is a no-op", async () => {
  const obj = { import: 42, local: "keep" };
  const expanded = await expandImports(obj, () => Promise.resolve(undefined));
  assertEquals(expanded.local, "keep");
  assertFalse("import" in expanded);
});

Deno.test("expandImports: cycle A→B→A is broken without infinite recursion", async () => {
  const obj = { import: "d/a", local: "top" };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/a": JSON.stringify({ import: "d/b", fromA: "yes" }),
      "d/b": JSON.stringify({ import: "d/a", fromB: "yes" }),
    }),
  );
  assertEquals(expanded.local, "top");
  // At least one of fromA/fromB came through; the loop must terminate.
  assert("fromA" in expanded || "fromB" in expanded);
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
  const obj = { import: ["d/lib", "ghost"] };
  const expanded = await expandImports(
    obj,
    fakeLookupFrom({
      "d/lib": JSON.stringify({ map: { "*": { value: "wildcard" } } }),
    }),
  );
  assertEquals(expanded.value, "wildcard");
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
  // Picks `_` if present; here only `m` exists so first valid hex wins.
  assertEquals(result, {
    type: "replaceable",
    pubkey: PK_ALT_M,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("resolveFromNamecoinValueAsync: failed import does not break local names", async () => {
  // Importer has its own `nostr.names`; the imported boilerplate happens
  // to be unreachable. Resolution still succeeds from local data.
  const apexRaw = JSON.stringify({
    import: "dd/missing",
    nostr: { names: { _: PK } },
  });
  const result = await resolveFromNamecoinValueAsync(
    apexRaw,
    () => Promise.resolve(undefined),
  );
  assertEquals(result, {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
});
