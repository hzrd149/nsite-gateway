import { Hono } from "@hono/hono";
import { pathExists, readTextFileIfExists, serveStaticFile } from "./static.ts";
import { NSITE_HOMEPAGE_DIR, ONION_HOST } from "./env.ts";
import { handleSiteRequest } from "./site.ts";

function requestLogger() {
  return async (
    c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: Parameters<Parameters<Hono["use"]>[1]>[1],
  ) => {
    const start = performance.now();
    await next();
    const end = performance.now();
    console.log(
      `${c.req.method} ${new URL(c.req.url).host}${
        new URL(c.req.url).pathname
      } ${c.res.status} ${(end - start).toFixed(1)}ms`,
    );
  };
}

function corsMiddleware() {
  return async (
    _c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: Parameters<Parameters<Hono["use"]>[1]>[1],
  ) => {
    await next();
    _c.res.headers.set("Access-Control-Allow-Origin", "*");
    _c.res.headers.set("Access-Control-Allow-Methods", "*");
    _c.res.headers.set("Access-Control-Allow-Headers", "Authorization,*");
    _c.res.headers.set("Access-Control-Expose-Headers", "*");
  };
}

export function buildApp() {
  const app = new Hono();
  const getStaticRoot =
    async () => ((await pathExists(NSITE_HOMEPAGE_DIR))
      ? NSITE_HOMEPAGE_DIR
      : "public");

  app.onError(
    (error) =>
      new Response(
        error instanceof Error ? error.message : "Internal Server Error",
        { status: 500 },
      ),
  );
  app.use("*", requestLogger());
  app.use("*", corsMiddleware());

  app.options("*", () => new Response(null, { status: 204 }));

  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const result = await handleSiteRequest(c.req.raw);
    if (result.response) return result.response;
    return next();
  });

  app.get("*", async (c) => {
    const root = await getStaticRoot();
    const response = await serveStaticFile(
      root,
      new URL(c.req.url).pathname,
      c.req.method,
    );
    if (response) return response;

    const fallback = await readTextFileIfExists("public/404.html");
    if (fallback) {
      return new Response(fallback, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });

  app.on(["HEAD"], "*", async (c) => {
    const root = await getStaticRoot();
    const response = await serveStaticFile(
      root,
      new URL(c.req.url).pathname,
      c.req.method,
    );
    if (response) return response;

    const headers = new Headers();
    if (ONION_HOST) headers.set("Onion-Location", ONION_HOST);
    return new Response(null, { status: 404, headers });
  });

  app.notFound(async () => {
    const fallback = await readTextFileIfExists("public/404.html");
    if (fallback) {
      return new Response(fallback, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });

  return app;
}
