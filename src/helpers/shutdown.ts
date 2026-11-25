/**
 * Shutdown phases, run in this order:
 * - `default`: stop timers, subscriptions, network clients and the server
 * - `flush`: write in-memory buffers to storage
 * - `storage`: close databases and caches
 */
export type ShutdownPhase = "default" | "flush" | "storage";

const PHASES: readonly ShutdownPhase[] = ["default", "flush", "storage"];

const handlers: Array<{ fn: () => Promise<void>; phase: ShutdownPhase }> = [];

let shuttingDown = false;

export function onShutdown(
  fn: () => Promise<void>,
  phase: ShutdownPhase = "default",
) {
  handlers.push({ fn, phase });
}

/** Runs every handler phase by phase, in registration order within a phase */
export async function runShutdownHandlers(): Promise<void> {
  for (const phase of PHASES) {
    for (const handler of handlers) {
      if (handler.phase !== phase) continue;
      try {
        await handler.fn();
      } catch (error) {
        console.error(`Shutdown handler (${phase}) failed:`, error);
      }
    }
  }
}

async function runShutdown() {
  if (shuttingDown) {
    console.log("Forcing shutdown...");
    Deno.exit(1);
  }

  shuttingDown = true;
  await runShutdownHandlers();

  console.log("Shutting down...");
  if (!Deno.env.has("DENO_WATCH_HMAC")) {
    Deno.exit(0);
  }
}

Deno.addSignalListener("SIGINT", runShutdown);
Deno.addSignalListener("SIGTERM", runShutdown);
