import { assertEquals } from "jsr:@std/assert";
import {
  LOADING_POLL_HEADER,
  wantsLoadingPage,
  WarmupRegistry,
  withinGrace,
} from "../site-loading.ts";

const BROWSER =
  "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";

function request(headers: Record<string, string>, method = "GET") {
  return new Request("https://example.com/", { method, headers });
}

Deno.test("wantsLoadingPage accepts browser document navigations", () => {
  assertEquals(
    wantsLoadingPage(
      request({ "user-agent": BROWSER, "sec-fetch-dest": "document" }),
    ),
    true,
  );
  assertEquals(
    wantsLoadingPage(
      request({ "user-agent": BROWSER, "sec-fetch-dest": "iframe" }),
    ),
    true,
  );
  // Older browsers without fetch metadata fall back to Accept
  assertEquals(
    wantsLoadingPage(
      request({ "user-agent": BROWSER, accept: "text/html,*/*;q=0.8" }),
    ),
    true,
  );
});

Deno.test("wantsLoadingPage rejects bots, subresources, ranges and polls", () => {
  const nav = { "user-agent": BROWSER, "sec-fetch-dest": "document" };
  assertEquals(
    wantsLoadingPage(
      request({
        "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)",
        "sec-fetch-dest": "document",
        accept: "text/html",
      }),
    ),
    false,
  );
  assertEquals(
    wantsLoadingPage(
      request({
        "user-agent": BROWSER,
        "sec-fetch-dest": "script",
        accept: "text/html",
      }),
    ),
    false,
  );
  assertEquals(wantsLoadingPage(request({ ...nav, range: "bytes=0-" })), false);
  assertEquals(
    wantsLoadingPage(request({ ...nav, [LOADING_POLL_HEADER]: "1" })),
    false,
  );
  assertEquals(wantsLoadingPage(request(nav, "HEAD")), false);
  assertEquals(
    wantsLoadingPage(request({ "user-agent": BROWSER, accept: "*/*" })),
    false,
  );
});

Deno.test("withinGrace returns undefined when the promise is slower", async () => {
  assertEquals(await withinGrace(Promise.resolve("ok"), 50), "ok");
  const slow = new Promise<string>((resolve) => setTimeout(resolve, 50, "x"));
  assertEquals(await withinGrace(slow, 0), undefined);
  await slow;
});

Deno.test("WarmupRegistry deduplicates running jobs and tracks stages", async () => {
  const registry = new WarmupRegistry({ maxSize: 10, failureTtl: 1000 });
  let runs = 0;
  let finish!: () => void;
  const run = async (setStage: (stage: "servers" | "blob") => void) => {
    runs++;
    setStage("servers");
    await new Promise<void>((resolve) => finish = resolve);
    setStage("blob");
    return "ready" as const;
  };

  const a = registry.start("k", run);
  const b = registry.start("k", run);
  assertEquals(a, b);
  assertEquals(runs, 1);
  assertEquals(registry.get("k")?.stage, "servers");

  finish();
  assertEquals(await a.done, "ready");
  assertEquals(registry.get("k")?.outcome, "ready");
  assertEquals(registry.getFailure("k"), undefined);

  // A finished successful job is replaced so evicted blobs can be refetched
  registry.start("k", run);
  assertEquals(runs, 2);
  finish();
});

Deno.test("WarmupRegistry remembers failures until the TTL expires", async () => {
  let now = 0;
  const registry = new WarmupRegistry({
    maxSize: 10,
    failureTtl: 1000,
    now: () => now,
  });
  let runs = 0;
  const fail = () => {
    runs++;
    return Promise.resolve("no-manifest" as const);
  };
  const throws = () => Promise.reject(new Error("boom"));

  await registry.start("a", fail).done;
  assertEquals(registry.getFailure("a"), "no-manifest");
  registry.start("a", fail);
  assertEquals(runs, 1);

  now = 1001;
  assertEquals(registry.getFailure("a"), undefined);
  assertEquals(registry.get("a"), undefined);
  await registry.start("a", fail).done;
  assertEquals(runs, 2);

  assertEquals(await registry.start("b", throws).done, "unavailable");
  assertEquals(registry.getFailure("b"), "unavailable");
});
