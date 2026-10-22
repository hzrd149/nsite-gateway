import { assertEquals } from "jsr:@std/assert";
import type { NostrEvent } from "applesauce-core/helpers";
import {
  getManifestAddressKey,
  getManifestIdentifier,
  getManifestPaths,
  getSnapshotParentAddress,
  isSiteManifestKind,
  parseManifestAddress,
  resolveManifestPath,
} from "../site-manifest.ts";

const pubkey = "ab".repeat(32);

function manifest(tags: string[][] = [], kind = 35128): NostrEvent {
  return {
    id: "1".repeat(64),
    pubkey,
    kind,
    created_at: 100,
    content: "",
    sig: "0".repeat(128),
    tags,
  };
}

Deno.test("manifest addresses preserve colon-containing and empty identifiers", () => {
  for (const identifier of ["", "blog", "blog:release:1"]) {
    const address = { kind: 35128, pubkey, identifier };
    assertEquals(parseManifestAddress(getManifestAddressKey(address)), address);
  }
  assertEquals(parseManifestAddress(`15128:${pubkey.toUpperCase()}:`), {
    kind: 15128,
    pubkey,
    identifier: "",
  });
});

Deno.test("manifest addresses reject malformed kinds, keys, and separators", () => {
  for (
    const value of [
      "",
      `35128:${pubkey}`,
      `-1:${pubkey}:blog`,
      `1.5:${pubkey}:blog`,
      `35128:${"g".repeat(64)}:blog`,
      `35128:${"a".repeat(63)}:blog`,
      `35128:${"a".repeat(65)}:blog`,
    ]
  ) {
    assertEquals(parseManifestAddress(value), undefined, value);
  }
});

Deno.test("only root and named manifests are site manifest kinds", () => {
  for (const kind of [15128, 35128]) {
    assertEquals(isSiteManifestKind(kind), true);
  }
  for (const kind of [0, 1, 5128, 35129]) {
    assertEquals(isSiteManifestKind(kind), false);
  }
});

Deno.test("snapshot parents require a snapshot and a valid site address", () => {
  const address = `35128:${pubkey}:blog`;
  assertEquals(getSnapshotParentAddress(manifest([["a", address]], 5128)), {
    kind: 35128,
    pubkey,
    identifier: "blog",
  });
  for (
    const event of [
      manifest([["a", address]]),
      manifest([], 5128),
      manifest([["a", "invalid"]], 5128),
      manifest([["a", `1:${pubkey}:blog`]], 5128),
    ]
  ) assertEquals(getSnapshotParentAddress(event), undefined);
});

Deno.test("manifest paths normalize relative paths and use the last duplicate", () => {
  const event = manifest([
    ["title", "Ignored"],
    ["path", ""],
    ["path", "assets/../index.html", "old"],
    ["path", "/index.html", "new"],
    ["path", "assets//main.css", "css"],
  ]);
  assertEquals(
    getManifestPaths(event),
    new Map([
      ["/index.html", "new"],
      ["/assets/main.css", "css"],
    ]),
  );
});

Deno.test("manifest path resolution prefers exact files over directory indexes", () => {
  const event = manifest([
    ["path", "/docs", "exact"],
    ["path", "/docs/index.html", "index"],
    ["path", "/404.html", "missing"],
  ]);
  assertEquals(resolveManifestPath(event, "docs"), {
    path: "/docs",
    sha256: "exact",
    is404: false,
  });
});

Deno.test("manifest path resolution serves root and nested directory indexes", () => {
  const event = manifest([
    ["path", "/index.html", "root"],
    ["path", "/docs/index.html", "docs"],
  ]);
  for (const path of ["/", ""]) {
    assertEquals(resolveManifestPath(event, path), {
      path: "/index.html",
      sha256: "root",
      is404: false,
    });
  }
  for (const path of ["docs", "/docs/", "/other/../docs"]) {
    assertEquals(resolveManifestPath(event, path), {
      path: "/docs/index.html",
      sha256: "docs",
      is404: false,
    });
  }
});

Deno.test("missing files use custom 404 without treating file extensions as directories", () => {
  const event = manifest([
    ["path", "/app.js/index.html", "wrong"],
    ["path", "/404.html", "missing"],
  ]);
  for (const path of ["/app.js", "/unknown", "/unknown/file.css"]) {
    assertEquals(resolveManifestPath(event, path), {
      path: "/404.html",
      sha256: "missing",
      is404: true,
    });
  }
  assertEquals(resolveManifestPath(event, "/404.html"), {
    path: "/404.html",
    sha256: "missing",
    is404: false,
  });
  assertEquals(resolveManifestPath(manifest(), "/missing"), undefined);
});

Deno.test("root manifests ignore d tags while named manifests retain identifiers", () => {
  assertEquals(
    getManifestIdentifier(manifest([["d", "ignored"]], 15128)),
    null,
  );
  assertEquals(getManifestIdentifier(manifest([["d", "blog"]])), "blog");
});
