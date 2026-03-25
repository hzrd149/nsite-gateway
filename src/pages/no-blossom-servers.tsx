import type { FC } from "@hono/hono/jsx";
import { Document } from "./_document.tsx";

type NoBlossomServersProps = {
  hostname: string;
};

export const NoBlossomServers: FC<NoBlossomServersProps> = ({ hostname }) => {
  return (
    <Document title="Storage unavailable">
      <h1>Storage unavailable</h1>
      <p>
        No Blossom servers are available for <strong>{hostname}</strong>.
      </p>
      <hr />
      <p class="muted">
        This nsite manifest does not include any reachable storage servers, and
        the site owner has not published a Blossom server list yet. If you own
        this site, publish at least one Blossom server and redeploy the site.
      </p>
    </Document>
  );
};
