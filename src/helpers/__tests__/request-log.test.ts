import { assertEquals, assertMatch } from "jsr:@std/assert";
import { Hono } from "@hono/hono";
import {
  logFields,
  requestError,
  requestLog,
  type RequestLogEnv,
} from "../request-log.ts";

Deno.test("service log fields are compact text with no raw objects or injected lines", () => {
  assertEquals(
    logFields({
      hits: 12,
      verification_ms: 1.234,
      error: new Error("bad\nline"),
      nested: {},
    }),
    "hits=12 verification_ms=1.2 error=Error:%20bad%0Aline nested=unavailable",
  );
});

Deno.test("request log isolates overlapping paths and records errors/nonblob defaults", async () => {
  const logs: unknown[][] = [];
  const original = console.log;
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const app = new Hono<RequestLogEnv>();
  app.use(requestLog);
  app.get("/blob", async (c) => {
    Object.assign(c.get("blobObservation"), {
      cache: "miss",
      verification: "incremental-sha256",
      verification_ms: 12,
      verified: true,
    });
    await gate;
    return c.body(null, 304);
  });
  app.get("/plain", (c) => c.text("ok"));
  app.get("/failed", () => {
    throw new Error("fixture");
  });
  app.onError(requestError);
  try {
    const blob = app.request("http://fixture/blob");
    await app.request("http://fixture/plain");
    await app.request("http://fixture/failed");
    release();
    await blob;
    const completions = logs.filter(([line]) => String(line).includes("-->"));
    assertEquals(completions.length, 3);
    assertEquals(
      completions.every((args) =>
        args.length === 1 && typeof args[0] === "string"
      ),
      true,
    );
    assertMatch(
      String(completions[0][0]),
      /plain 200 .*cache=none verification=none verification_ms=0/,
    );
    assertMatch(
      String(completions[1][0]),
      /failed 500 .*cache=none verification=none verification_ms=0/,
    );
    assertMatch(
      String(completions[2][0]),
      /blob 304 .*cache=miss verification=incremental-sha256 verification_ms=12/,
    );
    assertEquals(errors, [["[nsite:http] request failed: Error:%20fixture"]]);
  } finally {
    release();
    console.log = original;
    console.error = originalError;
  }
});
