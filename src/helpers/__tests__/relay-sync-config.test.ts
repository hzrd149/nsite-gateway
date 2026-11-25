import { assertEquals, assertThrows } from "jsr:@std/assert";
import { parseRelaySyncConfig } from "../relay-sync-config.ts";

Deno.test("relay sync defaults bound total and progress time but retain all history", () => {
  assertEquals(parseRelaySyncConfig({}), {
    totalTimeoutMs: 120_000,
    progressTimeoutMs: 15_000,
    lookbackSeconds: 0,
  });
  assertEquals(
    parseRelaySyncConfig({
      RELAY_SYNC_TIMEOUT: " ",
      RELAY_SYNC_PROGRESS_TIMEOUT: "",
      RELAY_SYNC_LOOKBACK: "",
    }),
    parseRelaySyncConfig({}),
  );
});

Deno.test("relay sync configuration converts seconds and accepts an explicit lookback", () => {
  assertEquals(
    parseRelaySyncConfig({
      RELAY_SYNC_TIMEOUT: " 300 ",
      RELAY_SYNC_PROGRESS_TIMEOUT: "30",
      RELAY_SYNC_LOOKBACK: "7776000",
    }),
    {
      totalTimeoutMs: 300_000,
      progressTimeoutMs: 30_000,
      lookbackSeconds: 7_776_000,
    },
  );
});

Deno.test("relay sync rejects malformed, negative and overflowing configuration", () => {
  for (
    const name of [
      "RELAY_SYNC_TIMEOUT",
      "RELAY_SYNC_PROGRESS_TIMEOUT",
      "RELAY_SYNC_LOOKBACK",
    ]
  ) {
    for (
      const value of [
        "-1",
        "NaN",
        "Infinity",
        "15s",
        "1.5",
        "1e3",
        "9007199254740992",
      ]
    ) {
      assertThrows(() => parseRelaySyncConfig({ [name]: value }), Error, name);
    }
  }
  for (const name of ["RELAY_SYNC_TIMEOUT", "RELAY_SYNC_PROGRESS_TIMEOUT"]) {
    for (const value of ["0", "2147484"]) {
      assertThrows(() => parseRelaySyncConfig({ [name]: value }), Error, name);
    }
  }
  assertEquals(
    parseRelaySyncConfig({ RELAY_SYNC_LOOKBACK: "0" }).lookbackSeconds,
    0,
  );
});
