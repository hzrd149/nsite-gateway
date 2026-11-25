import type { FC } from "@hono/hono/jsx";
import { css } from "../helpers/inline-css.ts";
import {
  LOADING_POLL_HEADER,
  type WarmupStage,
} from "../helpers/site-loading.ts";

const STAGE_MESSAGES: Record<WarmupStage, string> = {
  manifest: "Looking up the site on Nostr relays…",
  servers: "Finding the author's Blossom servers…",
  blob: "Downloading and verifying the page from Blossom…",
};

// Long-polls the same URL for warm-up progress. The server holds each poll
// until the stage changes or the job finishes, and the page always waits at
// least a jittered second between polls (backing off on errors), so even a
// misbehaving server cannot drive a tab past ~1 request per second. When the
// job is done, or a cache in front of the gateway answers with the real page,
// it reloads after a random delay so many waiting tabs do not reload in
// lockstep. A finished failure reloads too: the gateway then renders the real
// error page.
const POLL_SCRIPT = `
(() => {
  const messages = ${JSON.stringify(STAGE_MESSAGES)};
  const status = document.getElementById("stage");
  const slow = document.getElementById("slow");
  const started = Date.now();
  let stage = document.documentElement.dataset.stage;
  let failures = 0;
  const jitter = (ms) => ms + Math.random() * ms;
  const reload = () => setTimeout(() => location.reload(), Math.random() * 1000);
  async function poll() {
    if (Date.now() - started > 60000) slow.hidden = false;
    let wait = jitter(1000);
    try {
      const res = await fetch(location.href, {
        headers: { ${JSON.stringify(LOADING_POLL_HEADER)}: stage },
        cache: "no-store",
      });
      const type = res.headers.get("content-type") || "";
      if (res.ok && !type.includes("application/json")) return reload();
      if (!res.ok) throw new Error(res.status);
      const state = await res.json();
      if (state.done) return reload();
      failures = 0;
      if (Object.hasOwn(messages, state.stage)) {
        stage = state.stage;
        status.textContent = messages[stage];
      }
      if (state.retry > 0) wait = jitter(Math.min(state.retry, 60) * 1000);
    } catch {
      failures++;
      wait = jitter(Math.min(30000, 1000 * 2 ** failures));
    }
    setTimeout(poll, wait);
  }
  setTimeout(poll, jitter(500));
})();
`;

type SiteLoadingProps = {
  hostname: string;
  stage: WarmupStage;
};

/** Temporary page shown while a cold site is fetched in the background */
export const SiteLoading: FC<SiteLoadingProps> = ({ hostname, stage }) => {
  return (
    <html lang="en" data-stage={stage}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <noscript>
          <meta http-equiv="refresh" content="10" />
        </noscript>
        <title>Loading {hostname}…</title>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <main>
          <h1>Loading site…</h1>
          <p>
            <strong>{hostname}</strong>{" "}
            is being fetched from Nostr relays and Blossom servers. This page
            will show the site as soon as it is ready.
          </p>
          <p id="stage" class="muted" aria-live="polite">
            {STAGE_MESSAGES[stage]}
          </p>
          <p id="slow" class="warn" hidden>
            This is taking longer than expected. The relays or Blossom servers
            may be slow; you can keep waiting or <a href="">reload the page</a>.
          </p>
          <script dangerouslySetInnerHTML={{ __html: POLL_SCRIPT }} />
        </main>
      </body>
    </html>
  );
};
