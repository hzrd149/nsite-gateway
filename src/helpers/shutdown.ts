const handlers: Array<() => Promise<void>> = [];

let shuttingDown = false;

export function onShutdown(fn: () => Promise<void>) {
  handlers.push(fn);
}

async function runShutdown() {
  if (shuttingDown) {
    console.log("Forcing shutdown...");
    Deno.exit(1);
  }

  shuttingDown = true;
  for (const fn of handlers) {
    await fn();
  }

  console.log("Shutting down...");
  if (!Deno.env.has("DENO_WATCH_HMAC")) {
    Deno.exit(0);
  }
}

Deno.addSignalListener("SIGINT", runShutdown);
Deno.addSignalListener("SIGTERM", runShutdown);
