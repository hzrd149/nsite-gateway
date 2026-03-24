import type { FC } from "@hono/hono/jsx";
import { Document } from "./_document.tsx";

type InvalidAddressProps = {
  hostname: string;
  reason?: string;
};

export const InvalidAddress: FC<InvalidAddressProps> = (
  { hostname, reason },
) => {
  return (
    <Document title="Invalid address">
      <h1>Invalid address</h1>
      <p>
        The nsite address for <strong>{hostname}</strong> could not be parsed.
      </p>
      {reason && (
        <p>
          <code>{reason}</code>
        </p>
      )}
      <hr />
      <p class="muted">
        The hostname resolved to an nsite address that is malformed or
        unsupported. Check the DNS records for this domain and ensure they point
        to a valid Nostr pubkey or{" "}
        <a href="https://nostr.com/the-protocol/nip19">NIP-19</a> identifier.
      </p>
    </Document>
  );
};
