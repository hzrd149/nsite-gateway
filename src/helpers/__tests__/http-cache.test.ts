import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  createStrongEtag,
  createWeakFileEtag,
  hasMatchingIfNoneMatch,
} from "../http-cache.ts";

Deno.test("createStrongEtag quotes a content hash", () => {
  assertEquals(createStrongEtag("abc123"), '"abc123"');
});

for (
  const [name, header, expected] of [
    ["missing header", undefined, false],
    ["empty header", "", false],
    ["different entity", '"other"', false],
    ["strong validator", '"hash"', true],
    ["weak validator", 'W/"hash"', true],
    ["validator list", '"other", W/"hash", "third"', true],
    ["whitespace", '  W/"hash"  ', true],
    ["wildcard", "*", true],
    ["case-sensitive entity", '"HASH"', false],
  ] as const
) {
  Deno.test(`hasMatchingIfNoneMatch handles ${name}`, () => {
    const headers = new Headers();
    if (header !== undefined) headers.set("if-none-match", header);
    assertEquals(hasMatchingIfNoneMatch(headers, '"hash"'), expected);
  });
}

Deno.test("hasMatchingIfNoneMatch compares weak server validators", () => {
  assertEquals(
    hasMatchingIfNoneMatch(
      new Headers({ "if-none-match": '"hash"' }),
      'W/"hash"',
    ),
    true,
  );
});

Deno.test("range requests bypass conditional cache matches including wildcards", () => {
  for (const validator of ['"hash"', 'W/"hash"', "*"]) {
    assertEquals(
      hasMatchingIfNoneMatch(
        new Headers({ "if-none-match": validator, range: "bytes=0-99" }),
        '"hash"',
      ),
      false,
    );
  }
});

Deno.test("createWeakFileEtag uses size and modification time", () => {
  // Only these two fields are consumed; no filesystem access is needed.
  const stat = { size: 256, mtime: new Date(4096) } as Deno.FileInfo;
  assertEquals(createWeakFileEtag(stat), 'W/"100-1000"');
  assertNotEquals(
    createWeakFileEtag({ ...stat, size: 257 }),
    createWeakFileEtag(stat),
  );
  assertNotEquals(
    createWeakFileEtag({ ...stat, mtime: new Date(4097) }),
    createWeakFileEtag(stat),
  );
  assertEquals(createWeakFileEtag({ ...stat, mtime: null }), undefined);
  assertEquals(
    createWeakFileEtag({ ...stat, size: 0, mtime: new Date(0) }),
    'W/"0-0"',
  );
});
