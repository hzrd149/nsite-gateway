import { Hono } from "@hono/hono";
import { cors } from "@hono/hono/cors";
import { NSITE_HOMEPAGE_DIR, ONION_HOST } from "./helpers/env.ts";
import {
  createRequestLog,
  createRequestLogState,
  formatRequestErrorLine,
  formatRequestLogLine,
  type RequestLog,
  type RequestLogState,
} from "./helpers/request-log.ts";
import { pathExists, serveStaticFile } from "./services/static.ts";
import { handleSiteRequest } from "./site.ts";

type AppVariables = {
  requestLogState?: RequestLogState;
};

function getRequestLog(c: {
  get(key: "requestLogState"): RequestLogState | undefined;
  set(key: "requestLogState", value: RequestLogState): void;
}): RequestLog {
  let state = c.get("requestLogState");
  if (!state) {
    state = createRequestLogState();
    c.set("requestLogState", state);
  }
  return createRequestLog(state);
}

function requestLogger() {
  return async (c: any, next: any) => {
    const start = performance.now();
    const state = createRequestLogState();
    c.set("requestLogState", state);

    try {
      await next();
    } finally {
      const end = performance.now();
      const url = new URL(c.req.url);
      console.log(
        formatRequestLogLine(
          c.req.method,
          url,
          c.res.status,
          end - start,
          state,
        ),
      );

      for (const error of state.errors) {
        console.error(
          formatRequestErrorLine(
            c.req.method,
            url,
            error.message,
            error.fields,
          ),
        );
      }
    }
  };
}

const app = new Hono<{ Variables: AppVariables }>();
const staticRootPromise = pathExists(NSITE_HOMEPAGE_DIR).then((
  exists,
) => (exists ? NSITE_HOMEPAGE_DIR : "public"));
const getStaticRoot = async () => await staticRootPromise;

app.onError((error, c) => {
  const requestLog = getRequestLog(c);
  const message = error instanceof Error ? error.message : String(error);
  requestLog.setOutcome("error");
  requestLog.error(message, { status: 500 });

  return new Response(
    error instanceof Error ? error.message : "Internal Server Error",
    { status: 500 },
  );
});
app.use("*", requestLogger());
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "HEAD", "OPTIONS"],
    allowHeaders: ["Authorization"],
    exposeHeaders: ["*"],
  }),
);

app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  const result = await handleSiteRequest(c.req.raw, getRequestLog(c));
  if (result.response) return result.response;
  return next();
});

app.get("*", async (c) => {
  const requestLog = getRequestLog(c);
  const root = await getStaticRoot();
  const path = new URL(c.req.url).pathname;
  const response = await serveStaticFile(
    root,
    path,
    c.req.method,
    200,
    requestLog,
    c.req.raw.headers,
  );
  if (response) {
    requestLog.setOutcome("static-hit");
    return response;
  }

  requestLog.setOutcome("static-404");

  const fallback = await serveStaticFile(
    "public",
    "/404.html",
    c.req.method,
    404,
    undefined,
    c.req.raw.headers,
  );
  if (fallback) return fallback;
  return new Response("Not Found", { status: 404 });
});

app.on(["HEAD"], "*", async (c) => {
  const requestLog = getRequestLog(c);
  const root = await getStaticRoot();
  const path = new URL(c.req.url).pathname;
  const response = await serveStaticFile(
    root,
    path,
    c.req.method,
    200,
    requestLog,
    c.req.raw.headers,
  );
  if (response) {
    requestLog.setOutcome("static-hit");
    return response;
  }

  requestLog.setOutcome("static-404");

  const headers = new Headers();
  if (ONION_HOST) headers.set("Onion-Location", ONION_HOST);
  return new Response(null, { status: 404, headers });
});

app.notFound(async (c) => {
  getRequestLog(c).setOutcome("static-404");
  const fallback = await serveStaticFile("public", "/404.html", "GET", 404);
  if (fallback) return fallback;
  return new Response("Not Found", { status: 404 });
});

export default app;
