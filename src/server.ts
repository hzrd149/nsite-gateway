import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { handleLocalRouter } from "./local-router.ts";
import { handleSiteRequest } from "./routes/site.tsx";
import { resolvePubkeyFromHostname } from "./services/dns.ts";

const app = new Hono();

app.use(async (c, next) => {
  const hostname = new URL(c.req.url).hostname;
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  console.log(`  <-- ${method} ${hostname}${path}`);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`  --> ${method} ${hostname}${path} ${c.res.status} ${ms}ms`);
});

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    allowHeaders: ["Authorization"],
    exposeHeaders: ["*"],
  }),
);

app.all("*", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  const pointer = await resolvePubkeyFromHostname(hostname);
  if (pointer) {
    return await handleSiteRequest(c, pointer);
  }

  return await handleLocalRouter(c.req.raw);
});

export default app;
