import { assertEquals } from "jsr:@std/assert";
import {
  encodePubkeyB36,
  formatSnapshotSubdomain,
  parseNsiteHostname,
} from "../nsite-host.ts";

Deno.test("parseNsiteHostname resolves snapshot subdomains", () => {
  const eventId =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const subdomain = formatSnapshotSubdomain(eventId)!;

  assertEquals(parseNsiteHostname(`${subdomain}.example.com`), {
    type: "snapshot",
    id: eventId,
  });
});

Deno.test("parseNsiteHostname resolves canonical named sites", () => {
  const pubkey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const subdomain = `${encodePubkeyB36(pubkey)!}blog`;

  assertEquals(parseNsiteHostname(`${subdomain}.example.com`), {
    type: "replaceable",
    pubkey,
    identifier: "blog",
    kind: 35128,
  });
});

Deno.test("parseNsiteHostname rejects malformed snapshot labels", () => {
  assertEquals(parseNsiteHostname(`v${"0".repeat(49)}.example.com`), undefined);
});
