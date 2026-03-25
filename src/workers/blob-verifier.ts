import { createHash } from "node:crypto";
import logger from "../helpers/debug.ts";

type VerifyRequest = {
  id: string;
  sha256: string;
  stream: ReadableStream<Uint8Array>;
  maxFileSize: number;
};

type VerificationResult =
  | { ok: true; actualSha256: string; size: number }
  | { ok: false; reason: string; actualSha256?: string; size?: number };

type VerifyResponse = VerificationResult & { id: string };

const log = logger.extend("blob-verifier-worker");

self.onmessage = async (event: MessageEvent<VerifyRequest>) => {
  const { id, sha256, stream, maxFileSize } = event.data;
  const requestLog = log.extend(id).extend(sha256.slice(0, 12));

  requestLog(`Started verification (max=${maxFileSize} bytes)`);

  try {
    const hash = createHash("sha256");
    const reader = stream.getReader();
    let size = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      size += value.byteLength;
      if (size > maxFileSize) {
        requestLog(`Rejected stream: too large (${size} bytes)`);
        self.postMessage(
          { id, ok: false, reason: "too_large", size } satisfies VerifyResponse,
        );
        return;
      }

      hash.update(value);
    }

    const actualSha256 = hash.digest("hex");
    const result: VerificationResult = actualSha256 === sha256
      ? { ok: true, actualSha256, size }
      : { ok: false, reason: "hash_mismatch", actualSha256, size };

    if (result.ok) {
      requestLog(`Verified stream (${size} bytes)`);
    } else {
      requestLog(
        `Invalid stream: expected=${sha256} actual=${actualSha256} size=${size}`,
      );
    }

    self.postMessage({ id, ...result } satisfies VerifyResponse);
  } catch (error) {
    requestLog(
      `Verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    self.postMessage(
      {
        id,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      } satisfies VerifyResponse,
    );
  }
};
