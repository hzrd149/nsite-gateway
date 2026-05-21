import { assertEquals } from "jsr:@std/assert";
import {
  extractNsiteIdentifier,
  extractPubkeyFromNamecoinValue,
  isNamecoinHostname,
  parseNamecoinHostname,
  resolveFromNamecoinValue,
} from "./namecoin.ts";

const PK = "460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c";
const PK_UPPER = PK.toUpperCase();

Deno.test("isNamecoinHostname accepts .bit hostnames", () => {
  assertEquals(isNamecoinHostname("example.bit"), true);
  assertEquals(isNamecoinHostname("EXAMPLE.BIT"), true);
  assertEquals(isNamecoinHostname("blog.alice.bit"), true);
  assertEquals(isNamecoinHostname("example.bit."), true);
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
  });
  assertEquals(parseNamecoinHostname("EXAMPLE.BIT."), {
    hostname: "example.bit",
    namecoinName: "d/example",
  });
});

Deno.test("parseNamecoinHostname handles multi-label hostnames", () => {
  assertEquals(parseNamecoinHostname("blog.alice.bit"), {
    hostname: "blog.alice.bit",
    namecoinName: "d/alice",
  });
});

Deno.test("parseNamecoinHostname rejects invalid input", () => {
  assertEquals(parseNamecoinHostname("example.com"), undefined);
  assertEquals(parseNamecoinHostname(".bit"), undefined);
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

Deno.test("extractPubkeyFromNamecoinValue picks first valid hex when _ missing", () => {
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
  });
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
