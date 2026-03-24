import type { FC } from "@hono/hono/jsx";
import { Document } from "./_document.tsx";

type SiteNotFoundProps = {
  hostname: string;
};

export const SiteNotFound: FC<SiteNotFoundProps> = ({ hostname }) => {
  return (
    <Document title="Site not found">
      <h1>Site not found</h1>
      <p>
        No nsite is published for <strong>{hostname}</strong>.
      </p>
      <hr />
      <p class="muted">
        This gateway serves static sites published on{" "}
        <a href="https://nostr.com">Nostr</a>{" "}
        via the nsite protocol. If you own this domain, publish a site with{" "}
        <a href="https://github.com/nichenqin/nsyte">nsyte</a>{" "}
        and point your DNS here to get started.
      </p>
    </Document>
  );
};
