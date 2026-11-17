import { assertEquals } from "jsr:@std/assert";
import { getBlossomServers, isBlobHash, parseBlossomURL } from "../blossom.ts";

Deno.test("blob hashes accept only lowercase SHA-256 hex identifiers", () => {
  assertEquals(isBlobHash("0123456789abcdef".repeat(4)), true);
  for (
    const value of [
      undefined,
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      "a".repeat(64) + "\n",
      "etc/passwd",
      "https://example.com/blob",
    ]
  ) assertEquals(isBlobHash(value), false);
});

Deno.test("Blossom URLs reject non-HTTP transports and credentials", () => {
  for (
    const value of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "data:text/plain,secret",
      "javascript:alert(1)",
      "//example.com/",
      "not a URL",
      "https://user:secret@example.com/",
      "https://user@example.com/",
    ]
  ) assertEquals(parseBlossomURL(value), undefined, value);

  for (const value of ["https://example.com/", "http://blossom:24242/"]) {
    assertEquals(parseBlossomURL(value)?.href, value);
  }
});

Deno.test("server tags skip invalid entries and normalize valid roots", () => {
  assertEquals(
    getBlossomServers([
      ["server", "javascript:alert(1)"],
      ["server", "file:///"],
      ["server"],
      ["other", "https://ignored.example/"],
      ["server", "https://example.com/path?query=yes"],
      ["server", "https://example.com/"],
      ["server", "http://blossom:24242/"],
    ]),
    ["https://example.com/", "http://blossom:24242/"],
  );
});
