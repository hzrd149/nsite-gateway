import type { FC } from "@hono/hono/jsx";
import { Document } from "./_document.tsx";

type PathNotFoundProps = {
  hostname: string;
  pathname: string;
};

export const PathNotFound: FC<PathNotFoundProps> = ({ hostname, pathname }) => {
  return (
    <Document title="Page not found">
      <h1>Page not found</h1>
      <p>
        The path <code>{pathname}</code> was not found on{" "}
        <strong>{hostname}</strong>.
      </p>
      <hr />
      <p class="muted">
        This nsite does not publish a file at this path and has no custom 404
        page. If you own this site, publish the missing file or add a{" "}
        <code>/404.html</code> fallback using{" "}
        <a href="https://github.com/nichenqin/nsyte">nsyte</a>.
      </p>
    </Document>
  );
};
