import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { statusRequest } from "./routes/status.ts";
import { serveStaticFile } from "./services/static.ts";

const router = new Hono();
const servePublicFile = serveStatic({
  root: "./public",
  rewriteRequestPath: (path) => path === "/" ? "/index.html" : path,
});

router.onError((error) => {
  return new Response(
    error instanceof Error ? error.message : "Internal Server Error",
    { status: 500 },
  );
});

router.on(["GET", "HEAD"], "/status", async (c) => {
  return await statusRequest(c.req.raw);
});

router.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  return await servePublicFile(c, next);
});

router.notFound(async (c) => {
  const fallback = await serveStaticFile("public", "/404.html", "GET", 404);
  if (fallback) return fallback;
  return new Response("Not Found", { status: 404 });
});

export async function handleLocalRouter(request: Request): Promise<Response> {
  return await router.fetch(request);
}
