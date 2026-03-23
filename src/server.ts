import { Hono } from "@hono/hono";
import { handleLocalRouter } from "./local-router.ts";
import { handleNsiteRouter } from "./nsite-router.ts";
import { resolvePubkeyFromHostname } from "./services/dns.ts";

const app = new Hono();

app.all("*", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  const site = await resolvePubkeyFromHostname(hostname);
  if (site) {
    return await handleNsiteRouter(c.req.raw, site);
  }

  return await handleLocalRouter(c.req.raw);
});

export default app;
