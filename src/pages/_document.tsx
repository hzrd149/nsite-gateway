import type { Child, FC } from "@hono/hono/jsx";

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
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main class="padded">{children}</main>
      </body>
    </html>
  );
};
