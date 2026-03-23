import { assertEquals } from "jsr:@std/assert@^1.0.15";
import { BLOB_SOURCE_HEADER, streamBlob } from "../services/blossom.ts";
import { blobURLs } from "../services/cache.ts";

Deno.test({
  name: "streamBlob adds X-Blob-Source for successful blob responses",
  permissions: { env: true, net: true },
  async fn() {
    const sha256 = "b".repeat(64);
    let blobUrl = "";
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      (request: Request) => {
        assertEquals(request.url, blobUrl);
        return new Response("hello world", {
          headers: {
            "content-type": "text/plain",
            "content-length": "11",
          },
        });
      },
    );
    const address = server.addr as Deno.NetAddr;
    const origin = `http://${address.hostname}:${address.port}/`;
    blobUrl = new URL(sha256, origin).toString();

    blobURLs.delete(sha256);

    try {
      const response = await streamBlob(sha256, [origin]);

      assertEquals(response?.status, 200);
      assertEquals(response?.headers.get(BLOB_SOURCE_HEADER), blobUrl);
      assertEquals(await response?.text(), "hello world");
    } finally {
      await server.shutdown();
      blobURLs.delete(sha256);
    }
  },
});
