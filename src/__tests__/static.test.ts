import {
  assertEquals,
  assertExists,
  assertMatch,
} from "jsr:@std/assert@^1.0.15";
import { serveStaticFile } from "../static.ts";

Deno.test({
  name: "serveStaticFile adds validators for local files",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir();

    try {
      await Deno.writeTextFile(`${root}/index.html`, "hello world");

      const response = await serveStaticFile(root, "/index.html");

      assertEquals(response?.status, 200);
      assertEquals(
        response?.headers.get("cache-control"),
        "public, max-age=3600",
      );
      assertExists(response?.headers.get("etag"));
      assertExists(response?.headers.get("last-modified"));
      assertMatch(
        response?.headers.get("etag") || "",
        /^W\/"[0-9a-f]+-[0-9a-f]+"$/,
      );
      assertEquals(await response?.text(), "hello world");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "serveStaticFile returns 304 when If-None-Match matches",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir();

    try {
      await Deno.writeTextFile(`${root}/index.html`, "hello world");

    const initial = await serveStaticFile(root, "/index.html", "HEAD");
    const etag = initial?.headers.get("etag");

      const response = await serveStaticFile(
        root,
        "/index.html",
        "GET",
        200,
        undefined,
        new Headers({ "if-none-match": etag || "" }),
      );

      assertEquals(response?.status, 304);
      assertEquals(await response?.text(), "");
      assertEquals(response?.headers.get("etag"), etag);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test({
  name: "serveStaticFile ignores If-None-Match for range requests",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir();

    try {
      await Deno.writeTextFile(`${root}/index.html`, "hello world");

    const initial = await serveStaticFile(root, "/index.html", "HEAD");
    const etag = initial?.headers.get("etag");

      const response = await serveStaticFile(
        root,
        "/index.html",
        "GET",
        200,
        undefined,
        new Headers({
          "if-none-match": etag || "",
          "range": "bytes=0-4",
        }),
      );

      assertEquals(response?.status, 200);
      assertEquals(await response?.text(), "hello world");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
