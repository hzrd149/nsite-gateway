// Run explicitly with --allow-net --allow-read.
// This public dummy key/certificate is only for isolated tests.
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createPinnedFetch } from "../pinned-fetch.ts";

Deno.test("pinned HTTPS preserves Host, certificate hostname, signed query, HEAD and Range", async () => {
  const cert = await Deno.readTextFile(
    new URL("./fixtures/blob.test.crt", import.meta.url),
  );
  const key = await Deno.readTextFile(
    new URL("./fixtures/blob.test.key", import.meta.url),
  );
  const requests: { host: string | null; url: string }[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert,
    key,
    onListen() {},
  }, (request) => {
    requests.push({ host: request.headers.get("host"), url: request.url });
    return new Response(request.method === "HEAD" ? null : "blob", {
      status: request.headers.has("range") ? 206 : 200,
    });
  });
  const origin = `https://blob.test:${server.addr.port}`;
  const wrongOrigin = `https://wrong.test:${server.addr.port}`;
  let lookups = 0;
  const pinned = createPinnedFetch({
    ca: cert,
    // The .test hostname cannot resolve normally: only this pinned answer works.
    resolve: () => {
      lookups++;
      return Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    },
    trustedOrigins: [origin, wrongOrigin],
  });
  try {
    for (const method of ["GET", "HEAD"]) {
      const response = await pinned(`${origin}/blob?signature=a%2Fb`, {
        method,
        headers: { range: "bytes=0-3" },
        signal: AbortSignal.timeout(2000),
      });
      assertEquals(response.status, 206);
      assertEquals(await response.text(), method === "HEAD" ? "" : "blob");
    }
    assertEquals(lookups, 2);
    assertEquals(requests.map((r) => r.host), [
      `blob.test:${server.addr.port}`,
      `blob.test:${server.addr.port}`,
    ]);
    assertEquals(new URL(requests[0].url).search, "?signature=a%2Fb");
    // Trusting the destination address must not disable TLS hostname checks.
    await assertRejects(() =>
      pinned(`${wrongOrigin}/blob`, { signal: AbortSignal.timeout(2000) })
    );
    assertEquals(requests.length, 2);
  } finally {
    await server.shutdown();
  }
});

Deno.test("trusted-origin exceptions do not extend to redirect destinations", async () => {
  let hits = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (): Response => {
    hits++;
    return new Response(null, {
      status: 302,
      headers: { location: `http://127.0.0.1:${server.addr.port}/private` },
    });
  });
  const origin = `http://proxy.test:${server.addr.port}`;
  const pinned = createPinnedFetch({
    resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    trustedOrigins: [origin],
  });
  try {
    const signal = AbortSignal.timeout(2000);
    const response = await pinned(`${origin}/blob`, { signal });
    assertEquals(response.status, 302);
    await response.body?.cancel();
    await assertRejects(
      () => pinned(response.headers.get("location")!, { signal }),
      Error,
      "not public",
    );
    assertEquals(hits, 1);
  } finally {
    await server.shutdown();
  }
});
