/**
 * Static file server for the built PWA (web/dist) — Node built-ins only.
 *
 * The bridge serves the xterm.js PWA AND the WebSocket on the SAME port so a
 * single `tailscale serve --bg <port>` fronts one origin, and the web client's
 * same-origin `wss://<host>` (web/src/main.ts resolveBridgeUrl) just works (PR3,
 * prd "bridge serve 一个 xterm.js 网页"). HTTP GET and ws Upgrade coexist on `/`:
 * they're told apart by the `Upgrade` header, so this handler only ever sees
 * plain HTTP requests.
 *
 * Behaviour:
 *   - App shell: navigation requests (Accept: text/html, or path "/") get
 *     index.html so the SPA owns client-side routing.
 *   - Assets served by extension with the correct Content-Type.
 *   - `/sw.js` is served `no-cache` so service-worker updates always propagate
 *     (never long-cache the SW); hashed `/assets/*` may cache normally.
 *   - Path-traversal guard: anything resolving outside the dist root → 404.
 *   - GET/HEAD only (else 405); missing files → 404; no directory listing.
 *   - If web/dist is missing (not built yet) the server does not crash: GET
 *     returns 503 with a build hint and the ws server keeps running.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Resolve the default web-dist directory relative to THIS module, so it works
 * whether the bridge runs under tsx from `bridge/src/` or (were it ever built)
 * from `bridge/dist/`. Both sit one level under `bridge/`, so `../../web/dist`
 * lands on the repo's `web/dist` in either case.
 */
export function defaultWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../web/dist");
}

/** The one-line hint we print and serve when the PWA hasn't been built yet. */
export const WEB_DIST_MISSING_HINT =
  "web/dist not found — run: pnpm --filter @mobile-ssh/web build (serving WebSocket only)";

/** Map a file extension to a Content-Type. Defaults to octet-stream. */
function contentType(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/** True for a request that should receive the app shell (index.html). */
function isNavigationRequest(req: IncomingMessage, pathname: string): boolean {
  if (pathname === "/" || pathname === "") return true;
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html");
}

export interface StaticServerOptions {
  /** Absolute path to the built PWA directory (web/dist). */
  readonly webDist: string;
  /** Optional sink for the "dist missing" warning (defaults to console.warn). */
  readonly warn?: (message: string) => void;
}

/**
 * Build an HTTP request handler that serves files from `webDist`. The returned
 * handler is meant to be passed to `http.createServer`; ws Upgrade requests are
 * handled separately by the WebSocketServer attached to the same http.Server, so
 * they never reach here.
 */
export function createStaticHandler(
  options: StaticServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(options.webDist);
  const distExists = existsSync(root);
  if (!distExists) {
    (options.warn ?? ((m) => console.warn(`[mobile-ssh] ${m}`)))(WEB_DIST_MISSING_HINT);
  }

  return (req, res) => {
    // Only safe, body-less methods serve static content.
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
      res.end("Method Not Allowed");
      return;
    }

    // Not built yet: don't crash, just tell the caller how to build. The ws
    // server attached to the same http.Server keeps working regardless.
    if (!distExists) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(WEB_DIST_MISSING_HINT);
      return;
    }

    // Parse just the path; ignore query/hash. A leading "/" is required for
    // WHATWG URL with a base, which we get from req.url ("/..." for origin-form).
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }

    // Resolve the requested file inside the dist root. Navigation requests and
    // the bare root get the app shell.
    const target = isNavigationRequest(req, pathname)
      ? path.join(root, "index.html")
      : path.join(root, "." + pathname);

    // Path-traversal guard: the resolved absolute path must stay within root.
    // `path.join` already normalises "..", but we still verify the result is
    // contained so encoded traversal (e.g. "/%2e%2e/config.ts") can't escape.
    const resolved = path.resolve(target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      notFound(res);
      return;
    }

    // No file, or it's a directory (no directory listing) → 404.
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      notFound(res);
      return;
    }
    if (!stat.isFile()) {
      notFound(res);
      return;
    }

    const ext = path.extname(resolved);
    const headers: Record<string, string> = {
      "Content-Type": contentType(ext),
      "Content-Length": String(stat.size),
    };

    // Never long-cache the service worker, or clients get stuck on a stale SW.
    // Hashed assets under /assets/ are immutable (their URL changes per build).
    if (pathname === "/sw.js") {
      headers["Cache-Control"] = "no-cache";
    } else if (pathname.startsWith("/assets/")) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }

    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    res.writeHead(200, headers);
    const stream = createReadStream(resolved);
    stream.on("error", () => {
      // The stat succeeded but the read failed (race / permissions). Headers are
      // already sent, so we can only abort the response.
      res.destroy();
    });
    stream.pipe(res);
  };
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}
