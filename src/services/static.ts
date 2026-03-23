import { extname, join, normalize } from "@std/path";
import { contentType } from "@std/media-types";
import {
  createWeakFileEtag,
  hasMatchingIfNoneMatch,
} from "../helpers/http-cache.ts";
import type { RequestLog } from "../helpers/request-log.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return exists(path);
}

async function resolveFile(
  root: string,
  requestPath: string,
): Promise<{ filePath: string | null; rejected: boolean }> {
  const safePath = normalize(decodeURIComponent(requestPath)).replace(
    /^([.][.][\/\\])+/,
    "",
  );
  let candidate = join(root, safePath);

  try {
    const stat = await Deno.stat(candidate);
    if (stat.isDirectory) candidate = join(candidate, "index.html");
  } catch {
    if (!extname(candidate)) candidate = join(candidate, "index.html");
  }

  const resolvedRoot = await Deno.realPath(root);
  let resolvedCandidate: string;
  try {
    resolvedCandidate = await Deno.realPath(candidate);
  } catch {
    return { filePath: null, rejected: false };
  }

  if (!resolvedCandidate.startsWith(resolvedRoot)) {
    return { filePath: null, rejected: true };
  }
  return { filePath: resolvedCandidate, rejected: false };
}

export async function serveStaticFile(
  root: string,
  requestPath: string,
  method = "GET",
  status = 200,
  requestLog?: RequestLog,
  requestHeaders?: Pick<Headers, "get">,
): Promise<Response | null> {
  const { filePath, rejected } = await resolveFile(root, requestPath);
  if (rejected) {
    requestLog?.error("static path rejected", { path: requestPath });
  }
  if (!filePath || !(await exists(filePath))) return null;

  const headers = new Headers();
  const type = contentType(extname(filePath)) || "application/octet-stream";
  const stat = await Deno.stat(filePath);
  const etag = createWeakFileEtag(stat);

  headers.set("content-type", type);
  headers.set("cache-control", "public, max-age=3600");
  if (etag) headers.set("etag", etag);
  if (stat.mtime) headers.set("last-modified", stat.mtime.toUTCString());

  if (
    status === 200 && etag && requestHeaders &&
    hasMatchingIfNoneMatch(requestHeaders, etag)
  ) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(stat.size));

  if (method === "HEAD") {
    return new Response(null, { status, headers });
  }

  const file = await Deno.open(filePath, { read: true });
  return new Response(file.readable, { status, headers });
}
