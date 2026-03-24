import type { Child, FC } from "@hono/hono/jsx";

const baseStyles = Deno.readTextFileSync("public/styles.css");

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
        <style
          dangerouslySetInnerHTML={{
            __html: baseStyles + "\nmain { padding-top: 80px; }",
          }}
        />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
};
