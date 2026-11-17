import { assertEquals, assertRejects } from "jsr:@std/assert";
import { fetchBlossom } from "../blossom.ts";

async function withFetch(
  mock: typeof fetch,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("Blossom redirects preserve signed URLs, methods, ranges and the shared signal", async () => {
  for (const method of ["GET", "HEAD"]) {
    const signal = new AbortController().signal;
    const visited: string[] = [];
    let cancelled = 0;
    const signed = "https://bucket.s3.example/blob?signature=a%2Fb&expires=123";
    const locations = ["/storage", signed];
    await withFetch(
      (input, init) => {
        visited.push(String(input));
        assertEquals(init?.redirect, "manual");
        assertEquals(init?.method, method);
        assertEquals(init?.signal, signal);
        assertEquals(new Headers(init?.headers).get("range"), "bytes=0-9");
        const location = locations.shift();
        return Promise.resolve(
          location
            ? new Response(
              new ReadableStream({
                cancel: () => {
                  cancelled++;
                },
              }),
              { status: 302, headers: { location } },
            )
            : new Response(null, { status: 206 }),
        );
      },
      async () => {
        const response = await fetchBlossom("https://blossom.example/blob", {
          method,
          headers: { range: "bytes=0-9" },
          signal,
        });
        assertEquals(response.status, 206);
      },
    );
    assertEquals(visited, [
      "https://blossom.example/blob",
      "https://blossom.example/storage",
      signed,
    ]);
    assertEquals(cancelled, 2);
  }
});

Deno.test("Blossom rejects unsafe redirects before fetching their destinations", async () => {
  for (
    const location of [
      "file:///etc/passwd",
      "ftp://example.com/blob",
      "https://user:password@example.com/blob",
      "http://[invalid",
    ]
  ) {
    let calls = 0;
    await withFetch(
      () => {
        calls++;
        return Promise.resolve(
          new Response(null, { status: 307, headers: { location } }),
        );
      },
      async () => {
        await assertRejects(() =>
          fetchBlossom("https://blossom.example/blob", {
            signal: new AbortController().signal,
          })
        );
      },
    );
    assertEquals(calls, 1);
  }
});

Deno.test("Blossom handles all redirect statuses and rejects missing locations", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    await withFetch(
      () => Promise.resolve(new Response(null, { status })),
      async () => {
        await assertRejects(
          () =>
            fetchBlossom("https://blossom.example/blob", {
              signal: new AbortController().signal,
            }),
          Error,
          "missing Location",
        );
      },
    );
  }
});

Deno.test("Blossom stops redirect loops after five hops", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(
        new Response(null, { status: 308, headers: { location: "/blob" } }),
      );
    },
    async () => {
      await assertRejects(
        () =>
          fetchBlossom("https://blossom.example/blob", {
            signal: new AbortController().signal,
          }),
        Error,
        "Too many",
      );
    },
  );
  assertEquals(calls, 6);
});
