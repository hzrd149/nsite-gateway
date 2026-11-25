import { assertEquals } from "jsr:@std/assert";
import { naddrEncode, neventEncode, npubEncode } from "applesauce-core/helpers";
import {
  formatNsiteSubdomain,
  formatSnapshotSubdomain,
} from "../nsite-host.ts";
import { getSiteSubdomain, parseSiteAddress } from "../site-address.ts";

const pubkey = "7".repeat(64);
const id = "9".repeat(64);
const root = {
  type: "replaceable" as const,
  pubkey,
  identifier: "",
  kind: 15128,
};

Deno.test("parseSiteAddress accepts npub, hex and nostr: prefix", () => {
  const npub = npubEncode(pubkey);
  assertEquals(parseSiteAddress(npub), root);
  assertEquals(parseSiteAddress(` nostr:${npub} `), root);
  assertEquals(parseSiteAddress(pubkey.toUpperCase()), root);
});

Deno.test("parseSiteAddress accepts naddr and nevent", () => {
  const naddr = naddrEncode({ pubkey, identifier: "blog", kind: 35128 });
  assertEquals(parseSiteAddress(naddr), {
    type: "replaceable",
    pubkey,
    identifier: "blog",
    kind: 35128,
  });
  assertEquals(parseSiteAddress(neventEncode({ id }))?.type, "snapshot");
});

Deno.test("parseSiteAddress accepts gateway URLs and labels", () => {
  const label = formatNsiteSubdomain(pubkey, "blog")!;
  const parsed = parseSiteAddress(`https://${label}.nsite.example.com/about`);
  assertEquals(parsed?.type === "replaceable" && parsed.identifier, "blog");
  assertEquals(parseSiteAddress(label)?.type, "replaceable");
  const snapshot = formatSnapshotSubdomain(id)!;
  assertEquals(parseSiteAddress(snapshot), { type: "snapshot", id });
});

Deno.test("parseSiteAddress rejects garbage", () => {
  assertEquals(parseSiteAddress(""), undefined);
  assertEquals(parseSiteAddress("hello world"), undefined);
  assertEquals(parseSiteAddress("alice@example.com"), undefined);
  assertEquals(parseSiteAddress("npub1notvalid"), undefined);
});

Deno.test("getSiteSubdomain round-trips", () => {
  const site = parseSiteAddress(npubEncode(pubkey))!;
  assertEquals(getSiteSubdomain(site), npubEncode(pubkey));
});
