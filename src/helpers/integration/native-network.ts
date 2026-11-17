// Explicit integration suite: needs local networking, child Deno processes and
// temporary-directory access. Run with `deno task test:network` in isolation.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";

const config = JSON.parse(
  await Deno.readTextFile(new URL("../../../deno.json", import.meta.url)),
);
const publicPermissions = config.permissions["gateway-public-ipv4"];
const deny = publicPermissions.net.deny as string[];
const blossomModule = new URL("../blossom.ts", import.meta.url).href;

async function request(
  url: string,
  options: { deny?: string[]; method?: string; range?: string } = {},
) {
  const scratch = await Deno.makeTempDir({ prefix: "nsite-network-test-" });
  const headers = options.range ? { range: options.range } : {};
  const code = `
    import { fetchBlossom } from ${JSON.stringify(blossomModule)};
    try {
      const response = await fetchBlossom(${JSON.stringify(url)}, {
        method: ${JSON.stringify(options.method ?? "GET")},
        headers: ${JSON.stringify(headers)},
        signal: AbortSignal.timeout(3000),
      });
      console.log(JSON.stringify({
        status: response.status,
        body: await response.text(),
      }));
    } catch (error) {
      console.log(JSON.stringify({
        error: String(error) + " " + String(error.cause),
      }));
    }
  `;
  try {
    const configPath = `${scratch}/deno.json`;
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        permissions: {
          "gateway-public-ipv4": {
            ...publicPermissions,
            net: { allow: true, deny: options.deny ?? deny },
          },
        },
      }),
    );
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        configPath,
        "--no-lock",
        "--cached-only",
        "--no-prompt",
        "-P=gateway-public-ipv4",
        `data:application/javascript,${encodeURIComponent(code)}`,
      ],
      clearEnv: true,
      env: {
        HOME: scratch,
        TMPDIR: scratch,
        DENO_DIR: scratch,
        DENO_NO_UPDATE_CHECK: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    return JSON.parse(new TextDecoder().decode(output.stdout));
  } finally {
    await Deno.remove(scratch, { recursive: true });
  }
}

Deno.test("native deny policy blocks resolved names, IP aliases and mapped IPv6 before connecting", async () => {
  let hits = 0;
  const server = Deno.serve({
    hostname: "0.0.0.0",
    port: 0,
    onListen() {},
  }, () => {
    hits++;
    return new Response("private");
  });
  try {
    for (
      const host of [
        "127.0.0.1",
        "localhost",
        "2130706433",
        "0x7f000001",
        "[::ffff:127.0.0.1]",
        "[::1]",
      ]
    ) {
      const result = await request(`http://${host}:${server.addr.port}/blob`);
      assertStringIncludes(result.error, "net access", host);
    }
    assertEquals(hits, 0);
  } finally {
    await server.shutdown();
  }
});

// A fixture-only exception allows 127.0.0.1 while still denying the redirect
// destination. This cannot be used as a production public-network policy.
const fixtureDeny = deny.filter((rule) => rule !== "127.0.0.0/8")
  .concat("127.0.0.2/32");

Deno.test("native fetch preserves HEAD, Range and signed query strings", async () => {
  const seen: { method: string; range: string | null; search: string }[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (incoming) => {
    seen.push({
      method: incoming.method,
      range: incoming.headers.get("range"),
      search: new URL(incoming.url).search,
    });
    return new Response(incoming.method === "HEAD" ? null : "blob", {
      status: 206,
    });
  });
  try {
    for (const method of ["GET", "HEAD"]) {
      const result = await request(
        `http://127.0.0.1:${server.addr.port}/blob?signature=a%2Fb`,
        { deny: fixtureDeny, method, range: "bytes=0-3" },
      );
      assertEquals(result, {
        status: 206,
        body: method === "GET" ? "blob" : "",
      });
    }
    assertEquals(
      seen,
      ["GET", "HEAD"].map((method) => ({
        method,
        range: "bytes=0-3",
        search: "?signature=a%2Fb",
      })),
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("manual redirects cannot bypass native subnet-deny checks", async () => {
  let hits = 0;
  const server = Deno.serve({
    hostname: "0.0.0.0",
    port: 0,
    onListen() {},
  }, (): Response => {
    hits++;
    return new Response(null, {
      status: 302,
      headers: { location: `http://127.0.0.2:${server.addr.port}/private` },
    });
  });
  try {
    const result = await request(`http://127.0.0.1:${server.addr.port}/blob`, {
      deny: fixtureDeny,
    });
    assertStringIncludes(result.error, "net access");
    assertEquals(hits, 1);
  } finally {
    await server.shutdown();
  }
});
