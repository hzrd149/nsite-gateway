import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.15";
import {
  createStrongEtag,
  createWeakFileEtag,
  hasMatchingIfNoneMatch,
} from "../http-cache.ts";

Deno.test("matches exact If-None-Match value", () => {
  const headers = new Headers({ "if-none-match": '"abc123"' });

  assert(hasMatchingIfNoneMatch(headers, createStrongEtag("abc123")));
});

Deno.test("matches weak If-None-Match against strong ETag", () => {
  const headers = new Headers({ "if-none-match": 'W/"abc123"' });

  assert(hasMatchingIfNoneMatch(headers, createStrongEtag("abc123")));
});

Deno.test("matches one value from If-None-Match list", () => {
  const headers = new Headers({
    "if-none-match": '"nope", W/"abc123", "later"',
  });

  assert(hasMatchingIfNoneMatch(headers, createStrongEtag("abc123")));
});

Deno.test("does not match when range header is present", () => {
  const headers = new Headers({
    "if-none-match": '"abc123"',
    "range": "bytes=0-99",
  });

  assertFalse(hasMatchingIfNoneMatch(headers, createStrongEtag("abc123")));
});

Deno.test({
  name: "creates weak file ETag from size and mtime",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir();

    try {
      const filePath = `${root}/asset.txt`;
      await Deno.writeTextFile(filePath, "hello world");

      const stat = await Deno.stat(filePath);
      const etag = createWeakFileEtag(stat);

      assertEquals(
        etag,
        `W/"${stat.size.toString(16)}-${stat.mtime?.getTime().toString(16)}"`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
