import { assertEquals, assertRejects } from "jsr:@std/assert";
import { createPinnedFetch, isPublicAddress } from "../pinned-fetch.ts";

Deno.test("pinned transport rejects non-public and special-purpose addresses", () => {
  for (
    const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "64:ff9b::a00:1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "3fff::1",
      "not-an-IP",
    ]
  ) assertEquals(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assertEquals(isPublicAddress(address), true, address);
  }
});

Deno.test("pinned transport rejects mixed DNS answers and private URL literals", async () => {
  const pinned = createPinnedFetch({
    resolve: () =>
      Promise.resolve([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
  });
  for (
    const url of [
      "http://blob.test/file",
      "http://2130706433/file",
      "http://0x7f000001/file",
      "http://[::ffff:127.0.0.1]/file",
    ]
  ) {
    await assertRejects(
      () => pinned(url, { signal: new AbortController().signal }),
      Error,
      "not public",
    );
  }
});

Deno.test("the request deadline also bounds DNS resolution", async () => {
  const controller = new AbortController();
  const pinned = createPinnedFetch({ resolve: () => new Promise(() => {}) });
  const result = pinned("https://blob.test/file", {
    signal: controller.signal,
  });
  controller.abort(new Error("deadline"));
  await assertRejects(() => result, Error, "deadline");
});
