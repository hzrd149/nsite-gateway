import { extname, join, normalize } from "@std/path";
import { contentType } from "@std/media-types";
import type { RequestLog } from "./request-log.ts";

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
): Promise<Response | null> {
  const { filePath, rejected } = await resolveFile(root, requestPath);
  if (rejected) {
    requestLog?.error("static path rejected", { path: requestPath });
  }
  if (!filePath || !(await exists(filePath))) return null;

  const file = await Deno.open(filePath, { read: true });
  const headers = new Headers();
  const type = contentType(extname(filePath)) || "application/octet-stream";
  const stat = await file.stat();

  headers.set("content-type", type);
  headers.set("content-length", String(stat.size));
  headers.set("cache-control", "public, max-age=3600");

  if (method === "HEAD") {
    file.close();
    return new Response(null, { status, headers });
  }

  return new Response(file.readable, { status, headers });
}
