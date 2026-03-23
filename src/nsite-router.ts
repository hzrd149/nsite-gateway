import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { handleSiteRequest, type ResolvedSite } from "./site.ts";

const router = new Hono();

router.onError((error) => {
  return new Response(
    error instanceof Error ? error.message : "Internal Server Error",
    { status: 500 },
  );
});
router.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    allowHeaders: ["Authorization"],
    exposeHeaders: ["*"],
  }),
);
router.all("*", async (c) => {
  const site = c.req.raw.headers.get("x-nsite-target");
  if (!site) {
    return new Response("Missing nsite target", { status: 500 });
  }

  const [pubkey, identifier = ""] = site.split(":", 2);
  return await handleSiteRequest(
    c.req.raw,
    { pubkey, identifier } satisfies ResolvedSite,
  );
});

export async function handleNsiteRouter(
  request: Request,
  site: ResolvedSite,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("x-nsite-target", `${site.pubkey}:${site.identifier}`);
  const routedRequest = new Request(request, { headers });
  return await router.fetch(routedRequest);
}
