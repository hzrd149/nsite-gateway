import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { html } from "@hono/hono/html";
import { NSITE_HOST, ONION_HOST, PUBLIC_DOMAIN } from "./env.ts";
import { InvalidAddress } from "./pages/invalid-address.tsx";
import { handleLocalRouter } from "./routes/gateway.tsx";
import { handleSiteRequest } from "./routes/site.tsx";
import { resolvePubkeyFromHostname } from "./services/dns.ts";
import {
  requestError,
  requestLog,
  type RequestLogEnv,
} from "./helpers/request-log.ts";
import { incrementCounter, requestStats } from "./services/stats.ts";

const app = new Hono<RequestLogEnv>();
app.onError(requestError);

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

app.use(requestLog);
app.use(requestStats);

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
      incrementCounter("requests.site");
      return await handleSiteRequest(c, pointer);
    }

    incrementCounter("requests.invalid-host");
    return c.html(
      html`
        <!DOCTYPE html>${InvalidAddress({ hostname })}
      `,
      404,
    );
  }

  incrementCounter("requests.gateway");
  return await handleLocalRouter(c.req.raw);
});

export default app;
