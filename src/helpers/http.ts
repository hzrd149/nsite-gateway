import { IncomingMessage } from "http";
import followRedirects from "follow-redirects";
const { http, https } = followRedirects;

import agent from "../proxy.js";

export function makeRequestWithAbort(url: URL, controller: AbortController) {
  return new Promise<IncomingMessage>((res, rej) => {
    controller.signal.addEventListener("abort", () => rej(new Error("Aborted")));

    const request = (url.protocol === "https:" ? https : http).get(
      url,
      {
        signal: controller.signal,
        agent,
      },
      (response) => {
        res(response);
      },
    );
    request.on("error", (err) => rej(err));
    request.end();
  });
}
