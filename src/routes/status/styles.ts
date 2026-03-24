export const baseCss = `:root {
  color-scheme: light;
  --bg: #f6f4ec;
  --fg: #1f2328;
  --muted: #5a6472;
  --line: #d7d1c4;
  --accent: #0f6a5b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.5 "SFMono-Regular", "Cascadia Mono", "Liberation Mono", Menlo, monospace;
}
main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 24px 16px 40px;
}
h1, p { margin: 0; }
header {
  margin-bottom: 18px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.meta {
  margin-top: 6px;
  color: var(--muted);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
th {
  color: var(--muted);
  font-weight: 600;
}
a {
  color: var(--accent);
  text-decoration: none;
}
a:hover {
  text-decoration: underline;
}
@media (max-width: 820px) {
  table, thead, tbody, tr, th, td {
    display: block;
  }
  thead {
    display: none;
  }
  tr {
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  td {
    padding: 2px 0;
    border: 0;
  }
  td::before {
    content: attr(data-label) " ";
    color: var(--muted);
  }
}`;

export const siteDetailCss = `${baseCss}
section {
  margin-bottom: 28px;
}
h2 {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
  padding-bottom: 6px;
  margin: 24px 0 10px;
}
h3 {
  font-size: 13px;
  color: var(--muted);
  margin: 12px 0 4px;
  font-weight: 500;
}
.info-table {
  width: auto;
}
.info-table td {
  border: 0;
  padding: 3px 16px 3px 0;
}
.info-label {
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
  width: 1%;
}
.server-list {
  margin: 4px 0;
  padding-left: 20px;
  list-style: disc;
}
.server-list li {
  padding: 2px 0;
}
.empty {
  color: var(--muted);
  font-style: italic;
}
.none {
  color: var(--muted);
}
td[data-label="sha256"] {
  font-family: "SFMono-Regular", "Cascadia Mono", "Liberation Mono", Menlo, monospace;
}
details summary {
  cursor: pointer;
  user-select: none;
}
details summary h2 {
  margin: 0;
  border: 0;
  padding: 0;
}
.raw-json {
  margin: 10px 0 0;
  padding: 12px 14px;
  background: #edeae0;
  border: 1px solid var(--line);
  border-radius: 4px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}`;
