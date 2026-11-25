import type { ErrorHandler, MiddlewareHandler } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";

export interface BlobObservation {
  cache: "none" | "hit" | "miss" | "coalesced";
  verification:
    | "none"
    | "previously-verified"
    | "incremental-sha256"
    | "shared-fill";
  verification_ms: number;
  cache_wait_ms: number;
  verified: boolean;
}

export type RequestLogEnv = { Variables: { blobObservation: BlobObservation } };

export function newBlobObservation(): BlobObservation {
  return {
    cache: "none",
    verification: "none",
    verification_ms: 0,
    cache_wait_ms: 0,
    verified: false,
  };
}

/** Escape whitespace/control characters so values cannot split service log lines. */
export function logValue(value: unknown): string {
  const text = value instanceof Error
    ? `${value.name}: ${value.message}`
    : typeof value === "object" && value !== null
    ? "unavailable"
    : String(value);
  return text.replace(
    /[\s\x00-\x1f\x7f-\x9f]/g,
    (char) => encodeURIComponent(char),
  );
}

export function logFields(fields: object): string {
  return Object.entries(fields).map(([key, value]) =>
    `${key}=${
      logValue(typeof value === "number" ? Math.round(value * 10) / 10 : value)
    }`
  ).join(" ");
}

export const requestError: ErrorHandler<RequestLogEnv> = (error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(`[nsite:http] request failed: ${logValue(error)}`);
  return c.text("Internal Server Error", 500);
};

/** Completion here means response ready, not delivery of the streaming body. */
export const requestLog: MiddlewareHandler<RequestLogEnv> = async (c, next) => {
  const url = new URL(c.req.url);
  const target = `${c.req.method} ${logValue(url.hostname + url.pathname)}`;
  const observation = newBlobObservation();
  c.set("blobObservation", observation);
  console.log(`  <-- ${target}`);
  const start = performance.now();
  try {
    await next();
  } finally {
    console.log(
      `  --> ${target} ${c.res.status} ${
        logFields({
          response_ready_ms: performance.now() - start,
          ...observation,
        })
      }`,
    );
  }
};
