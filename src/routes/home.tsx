import { Hono } from "@hono/hono";
import { serveStatic } from "@hono/hono/deno";
import { homeRoute } from "../pages/home.tsx";
import statusRouter from "./status/index.ts";

const router = new Hono();
const servePublicFile = serveStatic({
  root: "./public",
  rewriteRequestPath: (path) => path === "/" ? "/index.html" : path,
});

let hasPublicIndex = false;
try {
  const stat = await Deno.stat("public/index.html");
  hasPublicIndex = stat.isFile;
} catch {
  hasPublicIndex = false;
}

router.onError((error) => {
  return new Response(
    error instanceof Error ? error.message : "Internal Server Error",
    { status: 500 },
  );
});

router.route("/status", statusRouter);

router.on(["GET", "HEAD"], "/", async (c, next) => {
  if (hasPublicIndex) return await servePublicFile(c, next);
  return homeRoute(c);
});

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
