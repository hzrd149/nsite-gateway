import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { html } from "@hono/hono/html";
import { NSITE_HOST, ONION_HOST, PUBLIC_DOMAIN } from "./env.ts";
import { InvalidAddress } from "./pages/invalid-address.tsx";
import { handleLocalRouter } from "./routes/home.tsx";
import { handleSiteRequest } from "./routes/site.tsx";
import { resolvePubkeyFromHostname } from "./services/dns.ts";

const app = new Hono();

function getOnionHostname(): string | undefined {
  if (!ONION_HOST) return undefined;

  try {
    return new URL(ONION_HOST).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

const GATEWAY_ROOT_HOSTS = new Set(
  ["localhost", "127.0.0.1", NSITE_HOST, PUBLIC_DOMAIN, getOnionHostname()]
    .filter((host): host is string => !!host)
    .map((host) => host.toLowerCase()),
);

function isGatewayRootHost(hostname: string): boolean {
  return GATEWAY_ROOT_HOSTS.has(hostname.toLowerCase());
}

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

  // Root hosts are already known locally; only resolve potential site hostnames.
  if (!isGatewayRootHost(hostname)) {
    const pointer = await resolvePubkeyFromHostname(hostname);
    if (pointer) {
      return await handleSiteRequest(c, pointer);
    }

    return c.html(
      html`
        <!DOCTYPE html>${InvalidAddress({ hostname })}
      `,
      404,
    );
  }

  return await handleLocalRouter(c.req.raw);
});

export default app;
