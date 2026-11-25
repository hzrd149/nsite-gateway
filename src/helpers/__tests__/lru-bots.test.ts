import { assertEquals } from "jsr:@std/assert";
import { isBotUserAgent } from "../bots.ts";
import { LruCache } from "../lru.ts";

Deno.test("LruCache evicts the least recently used entry", () => {
  const lru = new LruCache<string, number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.get("a");
  lru.set("c", 3);
  assertEquals(lru.get("b"), undefined);
  assertEquals(lru.get("a"), 1);
  assertEquals(lru.size, 2);
});

Deno.test("isBotUserAgent flags crawlers and scripts", () => {
  assertEquals(isBotUserAgent(undefined), true);
  assertEquals(
    isBotUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)"),
    true,
  );
  assertEquals(isBotUserAgent("curl/8.5.0"), true);
  assertEquals(isBotUserAgent("python-requests/2.31"), true);
  assertEquals(
    isBotUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    ),
    false,
  );
  assertEquals(
    isBotUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    ),
    false,
  );
});
