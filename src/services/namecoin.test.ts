import { assertEquals } from "jsr:@std/assert";
import {
  naddrEncode,
  neventEncode,
  noteEncode,
  nprofileEncode,
  npubEncode,
} from "applesauce-core/helpers";
import {
  extractNsiteIdentifier,
  extractPubkeyFromNamecoinValue,
  isNamecoinHostname,
  parseNamecoinHostname,
  resolveFromNamecoinValue,
} from "./namecoin.ts";

const PK = "460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c";
const PK_UPPER = PK.toUpperCase();
const ALT_PK = "1".repeat(64);
const EVENT_ID = "2".repeat(64);

function resolveRecord(value: unknown) {
  return resolveFromNamecoinValue(JSON.stringify(value));
}

Deno.test("isNamecoinHostname accepts .bit hostnames", () => {
  assertEquals(isNamecoinHostname("example.bit"), true);
  assertEquals(isNamecoinHostname("EXAMPLE.BIT"), true);
  assertEquals(isNamecoinHostname("blog.alice.bit"), true);
  assertEquals(isNamecoinHostname("example.bit."), true);
  // Invalid names still belong to the Namecoin routing path, never DNS.
  assertEquals(isNamecoinHostname("123.bit"), true);
  assertEquals(isNamecoinHostname("bad..example.bit"), true);
});

Deno.test("isNamecoinHostname rejects non-.bit hostnames", () => {
  assertEquals(isNamecoinHostname(""), false);
  assertEquals(isNamecoinHostname(".bit"), false);
  assertEquals(isNamecoinHostname("example.com"), false);
  assertEquals(isNamecoinHostname("localhost"), false);
  assertEquals(isNamecoinHostname("nsite.bit.example.com"), false);
});

Deno.test("parseNamecoinHostname strips .bit and prefixes d/", () => {
  assertEquals(parseNamecoinHostname("example.bit"), {
    hostname: "example.bit",
    namecoinName: "d/example",
    subdomains: [],
  });
  assertEquals(parseNamecoinHostname("EXAMPLE.BIT."), {
    hostname: "example.bit",
    namecoinName: "d/example",
    subdomains: [],
  });
});

Deno.test("parseNamecoinHostname handles multi-label hostnames", () => {
  assertEquals(parseNamecoinHostname("blog.alice.bit"), {
    hostname: "blog.alice.bit",
    namecoinName: "d/alice",
    subdomains: ["blog"],
  });
});

Deno.test("parseNamecoinHostname rejects invalid input", () => {
  assertEquals(parseNamecoinHostname("example.com"), undefined);
  assertEquals(parseNamecoinHostname(".bit"), undefined);
  assertEquals(parseNamecoinHostname("bad..example.bit"), undefined);
  assertEquals(parseNamecoinHostname("-bad.example.bit"), undefined);
  assertEquals(parseNamecoinHostname("123.bit"), undefined);
});

Deno.test("extractPubkeyFromNamecoinValue handles direct pubkey field", () => {
  assertEquals(extractPubkeyFromNamecoinValue({ pubkey: PK }), PK);
});

Deno.test("extractPubkeyFromNamecoinValue lowercases hex pubkey", () => {
  assertEquals(extractPubkeyFromNamecoinValue({ pubkey: PK_UPPER }), PK);
});

Deno.test("extractPubkeyFromNamecoinValue handles simple nostr form", () => {
  assertEquals(extractPubkeyFromNamecoinValue({ nostr: PK }), PK);
});

Deno.test("extractPubkeyFromNamecoinValue handles NIP-05 names map", () => {
  const value = {
    nostr: {
      names: { _: PK, alice: "1".repeat(64) },
      relays: { [PK]: ["wss://relay.example.com"] },
    },
  };
  assertEquals(extractPubkeyFromNamecoinValue(value), PK);
});

Deno.test("extractPubkeyFromNamecoinValue accepts one entry when _ missing", () => {
  const value = {
    nostr: {
      names: { alice: PK },
    },
  };
  assertEquals(extractPubkeyFromNamecoinValue(value), PK);
});

Deno.test("extractPubkeyFromNamecoinValue handles pubkey inside nostr object", () => {
  const value = { nostr: { pubkey: PK } };
  assertEquals(extractPubkeyFromNamecoinValue(value), PK);
});

Deno.test("extractPubkeyFromNamecoinValue returns undefined for invalid hex", () => {
  assertEquals(
    extractPubkeyFromNamecoinValue({ pubkey: "not-hex" }),
    undefined,
  );
  assertEquals(extractPubkeyFromNamecoinValue({}), undefined);
  assertEquals(extractPubkeyFromNamecoinValue(null), undefined);
  assertEquals(extractPubkeyFromNamecoinValue("string"), undefined);
});

Deno.test("extractPubkeyFromNamecoinValue ignores non-hex entries in names", () => {
  const value = {
    nostr: {
      names: { alice: "not-hex", bob: "still-not-hex" },
    },
  };
  assertEquals(extractPubkeyFromNamecoinValue(value), undefined);
});

Deno.test("extractNsiteIdentifier reads top-level nsite field", () => {
  assertEquals(extractNsiteIdentifier({ nsite: "blog" }), "blog");
});

Deno.test("extractNsiteIdentifier reads nostr.nsite field", () => {
  assertEquals(
    extractNsiteIdentifier({ nostr: { nsite: "blog" } }),
    "blog",
  );
});

Deno.test("extractNsiteIdentifier returns undefined when missing", () => {
  assertEquals(extractNsiteIdentifier({ pubkey: PK }), undefined);
  assertEquals(extractNsiteIdentifier({ nostr: { pubkey: PK } }), undefined);
});

Deno.test("resolveFromNamecoinValue returns root site by default", () => {
  const raw = JSON.stringify({ pubkey: PK });
  assertEquals(resolveFromNamecoinValue(raw), {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("resolveFromNamecoinValue returns named site when nsite hint present", () => {
  const raw = JSON.stringify({ pubkey: PK, nsite: "blog" });
  assertEquals(resolveFromNamecoinValue(raw), {
    type: "replaceable",
    pubkey: PK,
    identifier: "blog",
    kind: 35128,
  });
});

Deno.test("resolveFromNamecoinValue returns undefined for malformed JSON", () => {
  assertEquals(resolveFromNamecoinValue("not json"), undefined);
});

Deno.test("resolveFromNamecoinValue returns undefined when no pubkey", () => {
  assertEquals(resolveFromNamecoinValue(JSON.stringify({})), undefined);
});

Deno.test("resolveFromNamecoinValue handles full NIP-05 names map", () => {
  const raw = JSON.stringify({
    nostr: {
      names: { _: PK },
      relays: { [PK]: ["wss://relay.example.com"] },
    },
  });
  assertEquals(resolveFromNamecoinValue(raw), {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
    relays: ["wss://relay.example.com"],
  });
});

Deno.test("resolveFromNamecoinValue accepts all canonical NIP-19 target forms", () => {
  const relay = "wss://relay.example.com";
  assertEquals(resolveRecord({ nostr: { nsite: npubEncode(PK) } }), {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
  assertEquals(
    resolveRecord({
      nostr: { nsite: nprofileEncode({ pubkey: PK, relays: [relay] }) },
    }),
    {
      type: "replaceable",
      pubkey: PK,
      identifier: "",
      kind: 15128,
      relays: [relay],
    },
  );
  assertEquals(
    resolveRecord({
      nostr: {
        nsite: naddrEncode({
          pubkey: PK,
          identifier: "",
          kind: 15128,
          relays: [relay],
        }),
      },
    }),
    {
      type: "replaceable",
      pubkey: PK,
      identifier: "",
      kind: 15128,
      relays: [relay],
    },
  );
  assertEquals(
    resolveRecord({
      nostr: {
        nsite: naddrEncode({
          pubkey: PK,
          identifier: "blog",
          kind: 35128,
        }),
      },
    }),
    { type: "replaceable", pubkey: PK, identifier: "blog", kind: 35128 },
  );
  assertEquals(
    resolveRecord({
      nostr: {
        nsite: neventEncode({
          id: EVENT_ID,
          author: PK,
          kind: 35128,
          relays: [relay],
        }),
      },
    }),
    {
      type: "event",
      id: EVENT_ID,
      author: PK,
      kind: 35128,
      relays: [relay],
    },
  );
  assertEquals(resolveRecord({ nostr: { nsite: noteEncode(EVENT_ID) } }), {
    type: "event",
    id: EVENT_ID,
  });
});

Deno.test("resolveFromNamecoinValue rejects invalid naddr coordinates", () => {
  const pointers = [
    naddrEncode({ pubkey: PK, identifier: "blog", kind: 15128 }),
    naddrEncode({ pubkey: PK, identifier: "", kind: 35128 }),
    naddrEncode({ pubkey: PK, identifier: "blog", kind: 5128 }),
    naddrEncode({ pubkey: PK, identifier: "blog", kind: 1 }),
    naddrEncode({ pubkey: PK, identifier: "Blog", kind: 35128 }),
    naddrEncode({ pubkey: PK, identifier: "blog-", kind: 35128 }),
    naddrEncode({ pubkey: PK, identifier: "a".repeat(14), kind: 35128 }),
  ];
  for (const nsite of pointers) {
    assertEquals(resolveRecord({ nostr: { nsite, pubkey: PK } }), undefined);
  }
});

Deno.test("resolveFromNamecoinValue rejects unsupported exact-event kind hints", () => {
  const nsite = neventEncode({ id: EVENT_ID, kind: 1 });
  assertEquals(resolveRecord({ nostr: { nsite, pubkey: PK } }), undefined);
});

Deno.test("resolveFromNamecoinValue never falls back from malformed nested nsite", () => {
  const npub = npubEncode(PK);
  const malformed: unknown[] = [
    null,
    42,
    {},
    [],
    "",
    " blog ",
    "Blog",
    "blog-",
    "a".repeat(14),
    `nostr:${npub}`,
    ` ${npub}`,
    `${npub}/`,
    `${npub}?query=1`,
    `${npub}#fragment`,
    npub.toUpperCase(),
  ];
  for (const value of malformed) {
    assertEquals(
      resolveRecord({
        nostr: { nsite: value, pubkey: PK },
        nsite: "blog",
        pubkey: ALT_PK,
      }),
      undefined,
    );
  }
});

Deno.test("resolveFromNamecoinValue gives a direct pointer exclusive precedence", () => {
  const nsite = naddrEncode({
    pubkey: ALT_PK,
    identifier: "blog",
    kind: 35128,
  });
  assertEquals(
    resolveRecord({
      nostr: {
        nsite,
        names: { alice: PK, bob: PK },
        pubkey: "invalid",
      },
      pubkey: PK,
      nsite: npubEncode(PK),
    }),
    { type: "replaceable", pubkey: ALT_PK, identifier: "blog", kind: 35128 },
  );
});

Deno.test("resolveFromNamecoinValue supports the top-level nsite compatibility alias", () => {
  assertEquals(resolveRecord({ nsite: npubEncode(PK) }), {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("resolveFromNamecoinValue requires an identity for bare shorthand", () => {
  assertEquals(resolveRecord({ nostr: { nsite: "blog" } }), undefined);
  assertEquals(
    resolveRecord({
      nostr: {
        nsite: "blog",
        names: { alice: PK, bob: ALT_PK },
      },
      pubkey: PK,
    }),
    undefined,
  );
  assertEquals(
    resolveRecord({ nostr: { nsite: "blog" }, pubkey: PK_UPPER }),
    { type: "replaceable", pubkey: PK, identifier: "blog", kind: 35128 },
  );
});

Deno.test("legacy identity selection is deterministic and blocks alias fallback", () => {
  assertEquals(
    resolveRecord({
      nostr: { names: { alice: PK, bob: ALT_PK }, pubkey: PK },
      pubkey: PK,
    }),
    undefined,
  );
  assertEquals(
    resolveRecord({ nostr: { names: { _: "invalid" }, pubkey: PK } }),
    undefined,
  );
  assertEquals(
    resolveRecord({
      nostr: { names: { _: ALT_PK }, pubkey: PK },
      pubkey: PK,
    }),
    { type: "replaceable", pubkey: ALT_PK, identifier: "", kind: 15128 },
  );
});

Deno.test("legacy uppercase hex is normalized before relay map selection", () => {
  const relay = "wss://relay.example.com";
  assertEquals(
    resolveRecord({
      nostr: {
        names: { alice: PK_UPPER },
        relays: { [PK]: [relay] },
      },
    }),
    {
      type: "replaceable",
      pubkey: PK,
      identifier: "",
      kind: 15128,
      relays: [relay],
    },
  );
  assertEquals(resolveRecord({ nostr: PK_UPPER }), {
    type: "replaceable",
    pubkey: PK,
    identifier: "",
    kind: 15128,
  });
});

Deno.test("single identity relay hints apply only to the selected legacy author", () => {
  const relay = "wss://relay.example.com";
  assertEquals(
    resolveRecord({ nostr: { pubkey: PK_UPPER, relays: [relay] } }),
    {
      type: "replaceable",
      pubkey: PK,
      identifier: "",
      kind: 15128,
      relays: [relay],
    },
  );
  assertEquals(
    resolveRecord({
      nostr: { nsite: npubEncode(ALT_PK), pubkey: PK, relays: [relay] },
    }),
    { type: "replaceable", pubkey: ALT_PK, identifier: "", kind: 15128 },
  );
});

// Integration test — only runs when the operator opts in.
Deno.test({
  name: "resolveNamecoinHostname queries live ElectrumX (integration)",
  ignore: !Deno.env.get("NSITE_NAMECOIN_INTEGRATION"),
  async fn() {
    const { resolveNamecoinHostname } = await import("./namecoin.ts");
    const result = await resolveNamecoinHostname(
      Deno.env.get("NSITE_NAMECOIN_INTEGRATION_HOSTNAME") ?? "example.bit",
    );
    // We don't assert a specific pubkey; we just sanity-check the shape.
    if (result) {
      assertEquals(result.type, "replaceable");
    }
  },
});
