import type { FC } from "@hono/hono/jsx";
import { Document } from "./_document.tsx";

type TreeNode = {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
};

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: "/", path: "/", children: new Map() };
  for (const p of paths.sort()) {
    const parts = p.replace(/^\//, "").split("/");
    let node = root;
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, path: current, children: new Map() });
      }
      node = node.children.get(part)!;
    }
  }
  return root;
}

function renderTree(node: TreeNode, prefix: string = ""): any[] {
  const entries = [...node.children.values()];
  const lines: any[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const isFile = entry.children.size === 0;
    lines.push(
      <span>
        {prefix}{connector}
        {isFile ? <a href={entry.path}>{entry.name}</a> : entry.name}
        {"\n"}
      </span>,
    );
    const childPrefix = prefix + (isLast ? "    " : "│   ");
    lines.push(...renderTree(entry, childPrefix));
  }
  return lines;
}

type PathNotFoundProps = {
  hostname: string;
  pathname: string;
  paths: string[];
};

export const PathNotFound: FC<PathNotFoundProps> = ({ hostname, pathname, paths }) => {
  const tree = buildTree(paths);
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
      {paths.length > 0 && (
        <section>
          <h2>Files on this site</h2>
          <pre><code>{renderTree(tree)}</code></pre>
        </section>
      )}
    </Document>
  );
};
