import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path/posix";
import { STATS_PATH } from "../env.ts";
import logger from "../helpers/debug.ts";
import { logValue } from "../helpers/request-log.ts";
import { onShutdown } from "../helpers/shutdown.ts";
import { migrate } from "../helpers/stats-store.ts";

const log = logger.extend("stats-db");

/** Opens a stats database and applies schema migrations */
export function openStatsDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

log(`Opening stats database at ${STATS_PATH}`);
if (STATS_PATH !== ":memory:") {
  await Deno.mkdir(dirname(STATS_PATH), { recursive: true });
}

/** Singleton stats database (analytics, counters, directory snapshot) */
export const statsDb = openStatsDb(STATS_PATH);

onShutdown(() => {
  log("Closing stats database");
  try {
    statsDb.close();
  } catch (err) {
    log("Got error while closing stats database: %s", logValue(err));
  }
  return Promise.resolve();
}, "storage");
