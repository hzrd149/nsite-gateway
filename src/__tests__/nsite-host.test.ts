import { assertEquals, assertExists } from "jsr:@std/assert@^1.0.15";
import { nip19 } from "nostr-tools";
import {
  decodePubkeyB36,
  encodePubkeyB36,
  formatNsiteSubdomain,
  parseNsiteHostname,
} from "../nsite-host.ts";

const PUBKEY =
  "266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5";
const NPUB = nip19.npubEncode(PUBKEY);

Deno.test("pubkey base36 roundtrips with fixed width", () => {
  const pubkeyB36 = encodePubkeyB36(PUBKEY);

  assertExists(pubkeyB36);
  assertEquals(pubkeyB36.length, 50);
  assertEquals(decodePubkeyB36(pubkeyB36), PUBKEY);
});

Deno.test("parses canonical root hostname", () => {
  assertEquals(parseNsiteHostname(`${NPUB}.example.com`), {
    pubkey: PUBKEY,
    identifier: "",
  });
});

Deno.test("parses canonical named-site hostname", () => {
  const label = formatNsiteSubdomain(PUBKEY, "blog");

  assertEquals(parseNsiteHostname(`${label}.example.com`), {
    pubkey: PUBKEY,
    identifier: "blog",
  });
});

Deno.test("parses legacy named-site hostname", () => {
  assertEquals(parseNsiteHostname(`blog.${NPUB}.example.com`), {
    pubkey: PUBKEY,
    identifier: "blog",
  });
});

Deno.test("falls back to legacy format for non-canonical identifiers", () => {
  assertEquals(formatNsiteSubdomain(PUBKEY, "my-blog"), `my-blog.${NPUB}`);
});

Deno.test("rejects oversized canonical named-site labels", () => {
  const pubkeyB36 = encodePubkeyB36(PUBKEY);

  assertExists(pubkeyB36);
  assertEquals(
    parseNsiteHostname(`${pubkeyB36}abcdefghijkl.example.com`),
    undefined,
  );
});
