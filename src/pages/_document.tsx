import type { Child, FC } from "@hono/hono/jsx";
import { css } from "../helpers/inline-css.ts";

type DocumentProps = {
  title: string;
  children: Child;
};

export const Document: FC<DocumentProps> = ({ title, children }) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <main>
          <header>
            <h1>{title}</h1>
            <a href="/">&larr; back to gateway</a>
          </header>
          {children}
        </main>
      </body>
    </html>
  );
};
