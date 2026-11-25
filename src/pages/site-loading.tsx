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

// Polls the same URL for warm-up progress and reloads once it has finished.
// A finished failure reloads too: the gateway then renders the real error.
const POLL_SCRIPT = `
(() => {
  const messages = ${JSON.stringify(STAGE_MESSAGES)};
  const status = document.getElementById("stage");
  const slow = document.getElementById("slow");
  const started = Date.now();
  async function poll() {
    const late = Date.now() - started > 60000;
    if (late) slow.hidden = false;
    try {
      const res = await fetch(location.href, {
        headers: { ${JSON.stringify(LOADING_POLL_HEADER)}: "1" },
        cache: "no-store",
      });
      if (res.ok) {
        const state = await res.json();
        if (state.done) return location.reload();
        if (messages[state.stage]) status.textContent = messages[state.stage];
      }
    } catch {}
    setTimeout(poll, late ? 3000 : 1000);
  }
  setTimeout(poll, 1000);
})();
`;

type SiteLoadingProps = {
  hostname: string;
  stage: WarmupStage;
};

/** Temporary page shown while a cold site is fetched in the background */
export const SiteLoading: FC<SiteLoadingProps> = ({ hostname, stage }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <noscript>
          <meta http-equiv="refresh" content="3" />
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
