import { assertEquals } from "jsr:@std/assert";
import { decodeHex32B36, encodeHex32B36 } from "../base36.ts";

Deno.test("encodeHex32B36 round trips a 32-byte hex value", () => {
  const hex =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const encoded = encodeHex32B36(hex);

  assertEquals(encoded?.length, 50);
  assertEquals(decodeHex32B36(encoded!), hex);
});

Deno.test("encodeHex32B36 pads zero value to 50 chars", () => {
  const encoded = encodeHex32B36("0".repeat(64));

  assertEquals(encoded, "0".repeat(50));
});
