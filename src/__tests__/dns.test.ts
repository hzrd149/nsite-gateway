import { assertEquals } from "jsr:@std/assert@^1.0.15";

const PUBKEY =
  "266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5";
const NPUB = "npub1ye5ptcxfyyxl5vjvdjar2ua3f0hynkjzpx552mu5snj3qmx5pzjscpknpr";

async function loadDnsModule() {
  return await import(`../services/dns.ts?test=${crypto.randomUUID()}`);
}

Deno.test({
  name: "resolvePubkeyFromHostname parses canonical hostname directly",
  permissions: { env: true, read: true },
  async fn() {
    const { resolvePubkeyFromHostname } = await loadDnsModule();
    const response = await resolvePubkeyFromHostname(
      `${NPUB}.gateway.net`,
    );

    assertEquals(response, {
      pubkey: PUBKEY,
      identifier: "",
    });
  },
});

Deno.test({
  name: "resolvePubkeyFromHostname parses canonical hostname from CNAME",
  permissions: { env: true, read: true },
  async fn() {
    const { resolvePubkeyFromHostname } = await loadDnsModule();
    const response = await resolvePubkeyFromHostname(
      "blog.gateway.net",
      async (hostname: string, recordType: Deno.RecordType) => {
        assertEquals(hostname, "blog.gateway.net");
        assertEquals(recordType, "CNAME");
        return [
          `${NPUB}.gateway.net`,
        ];
      },
    );

    assertEquals(response, {
      pubkey: PUBKEY,
      identifier: "",
    });
  },
});

Deno.test({
  name: "resolvePubkeyFromHostname ignores legacy hostnames",
  permissions: { env: true, read: true },
  async fn() {
    const { resolvePubkeyFromHostname } = await loadDnsModule();
    const response = await resolvePubkeyFromHostname(
      `blog.${NPUB}.gateway.net`,
      async () => [],
    );

    assertEquals(response, undefined);
  },
});
