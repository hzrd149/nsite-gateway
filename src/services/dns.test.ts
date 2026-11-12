import { assertEquals } from "jsr:@std/assert";
import { npubEncode } from "applesauce-core/helpers";
import type { ResolvedSiteAddress } from "../helpers/resolved-site.ts";
import { cache, setDNSPubkey } from "./cache.ts";
import { resolvePubkeyFromHostname } from "./dns.ts";

const PK = "460c25e682fda7832b52d1f22d3d22b3176d972f60dcdc3212ed8c92ef85065c";
const ALT_PK = "1".repeat(64);

Deno.test("invalid .bit names never fall through to DNS CNAME", async () => {
  let dnsCalls = 0;
  let namecoinCalls = 0;
  const resolved = await resolvePubkeyFromHostname(
    "123.bit",
    () => {
      dnsCalls++;
      return Promise.resolve([`${npubEncode(PK)}.example.com`]);
    },
    () => {
      namecoinCalls++;
      return Promise.resolve(undefined);
    },
  );

  assertEquals(resolved, undefined);
  assertEquals(namecoinCalls, 1);
  assertEquals(dnsCalls, 0);
});

Deno.test("Namecoin resolution does not reuse a cached pointer", async () => {
  const hostname = "refresh.example.bit";
  const stale: ResolvedSiteAddress = {
    type: "replaceable",
    pubkey: ALT_PK,
    identifier: "",
    kind: 15128,
  };
  const fresh: ResolvedSiteAddress = {
    type: "replaceable",
    pubkey: PK,
    identifier: "blog",
    kind: 35128,
  };
  await setDNSPubkey(hostname, stale);

  try {
    let namecoinCalls = 0;
    const resolved = await resolvePubkeyFromHostname(
      hostname,
      () => Promise.resolve([]),
      () => {
        namecoinCalls++;
        return Promise.resolve(fresh);
      },
    );

    assertEquals(resolved, fresh);
    assertEquals(namecoinCalls, 1);
  } finally {
    await cache.delete(["dns", hostname]);
  }
});
