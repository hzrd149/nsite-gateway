import type { Child, FC } from "@hono/hono/jsx";
import { css } from "../../helpers/inline-css.ts";

/** Short content hash of styles.css for cache busting */
export const CSS_VERSION = await crypto.subtle
  .digest("SHA-1", new TextEncoder().encode(css))
  .then((hash) =>
    Array.from(
      new Uint8Array(hash).slice(0, 6),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("")
  );

/** HTML document shell shared by every gateway page */
export const Layout: FC<{
  title: string;
  description?: string;
  noindex?: boolean;
  class?: string;
  children: Child;
}> = ({ title, description, noindex, children, ...props }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      {description && <meta name="description" content={description} />}
      {noindex && <meta name="robots" content="noindex, nofollow" />}
      <link rel="stylesheet" href={`/styles.css?v=${CSS_VERSION}`} />
    </head>
    <body>
      <main class={props.class}>{children}</main>
    </body>
  </html>
);
