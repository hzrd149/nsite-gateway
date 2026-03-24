import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import statusRouter from "./routes/status/index.ts";

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

router.route("/status", statusRouter);

router.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  return await servePublicFile(c, next);
});

router.notFound(async () => {
  try {
    const html = await Deno.readTextFile("public/404.html");
    return new Response(html, {
      status: 404,
      headers: { "content-type": "text/html; charset=UTF-8" },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
});

export async function handleLocalRouter(request: Request): Promise<Response> {
  return await router.fetch(request);
}
