import { assertEquals } from "jsr:@std/assert";
import { onShutdown, runShutdownHandlers } from "../shutdown.ts";

Deno.test("shutdown handlers run by phase, then registration order", async () => {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
    return Promise.resolve();
  };

  onShutdown(record("storage"), "storage");
  onShutdown(record("flush-1"), "flush");
  onShutdown(record("default-1"));
  onShutdown(() => Promise.reject(new Error("boom")), "flush");
  onShutdown(record("flush-2"), "flush");
  onShutdown(record("default-2"), "default");

  await runShutdownHandlers();

  assertEquals(calls, [
    "default-1",
    "default-2",
    "flush-1",
    "flush-2",
    "storage",
  ]);
});
