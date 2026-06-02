# Bridge HTTP + WebSocket Serving

> How the bridge serves the PWA and the terminal WebSocket on a **single origin**,
> and why that origin must stay loopback-only. Read before touching `ws-server.ts`,
> `static-server.ts`, or adding any HTTP endpoint (PR4 hooks land here too).

---

## Scenario: Single-origin static + ws on one loopback port

### 1. Scope / Trigger

Infra / cross-layer contract. One Node `http.Server` hosts **both** the built PWA
(`web/dist`, HTTP GET) **and** the terminal WebSocket (Upgrade) on the **same port**,
so a single `tailscale serve --bg <port>` fronts one HTTPS origin and the web client's
**same-origin** `wss://<host>` (`web/src/main.ts → resolveBridgeUrl`) just works.
This is the prd "bridge serve 一个 xterm.js 网页" requirement and the load-bearing
half of the real-device runbook.

### 2. Signatures

```ts
// ws-server.ts
new TerminalServer(session, {
  port: number,            // loopback TCP port (default 8866 via BRIDGE_PORT)
  host?: string,           // defaults to "127.0.0.1" — DO NOT wire to env/CLI (see §4)
  webDist?: string,        // built PWA dir; omit → ws-only, GETs 404 (tests do this)
  warn?: (msg: string) => void,
})
// Internally: http.createServer(staticHandler); new WebSocketServer({ server: http })

// static-server.ts
createStaticHandler(opts: { webDist: string; warn?: (m: string) => void }):
  (req: IncomingMessage, res: ServerResponse) => void
defaultWebDist(): string         // resolve(<thisDir>, "../../web/dist")
WEB_DIST_MISSING_HINT: string    // build hint, served as the 503 body
```

### 3. Contracts

**Env** (`config.ts`):
- `WEB_DIST` (optional) → `webDist`; default `defaultWebDist()` = repo `web/dist`.
- `BRIDGE_PORT` (optional, default `8866`) → the one shared port.

**HTTP response contract** (static handler):

| Request | Response |
|---------|----------|
| `GET /` or any `Accept: text/html` route | `200` `index.html` (`text/html`) — SPA fallback |
| `GET /sw.js` | `200` `text/javascript` + `Cache-Control: no-cache` |
| `GET /assets/<hashed>` | `200` + `Cache-Control: public, max-age=31536000, immutable` |
| `GET /<other existing file>` | `200` with extension-derived `Content-Type` |
| `HEAD <any of the above>` | same headers, empty body |
| missing/dir/escaping path | `404` |
| method ∉ {GET, HEAD} | `405` + `Allow: GET, HEAD` |
| `webDist` not built | `503` + `WEB_DIST_MISSING_HINT` (ws stays up) |

**WebSocket contract**: unchanged from PR2. Upgrade requests are consumed by the
attached `WebSocketServer` and never reach the static handler; the
attach→ready→delta-replay→live + ping/pong + 24s watchdog lifecycle is identical.

### 4. Validation & Error Matrix

- `host` other than loopback (e.g. `0.0.0.0`) → **public ingress = DoD violation**.
  `host` exists in the options type but is intentionally **not** wired to any env/CLI
  so it cannot be flipped by accident; `index.ts` never passes it.
- Tailscale **Funnel** (public) instead of `serve` (tailnet-only) → DoD violation. Forbidden.
- Path escaping `webDist` (incl. encoded `%2e%2e`) → `404`. Guard: WHATWG `URL` collapses
  dot-segments, then `path.resolve` + `startsWith(root + path.sep)` containment check.
- Long-caching `/sw.js` → clients stuck on a stale service worker. Always `no-cache`.
- New HTTP endpoints (PR4 `/hooks/*`) MUST mount on this same `http.Server` (same origin),
  not a second port/server.

### 5. Good / Base / Bad Cases

- **Good**: `pnpm --filter @mobile-ssh/web build` → `pnpm --filter @mobile-ssh/bridge start`
  → `tailscale serve --bg 8866` → phone opens `https://<host>.<tailnet>.ts.net`, same-origin
  `wss` connects, SW registers (secure context).
- **Base**: bridge started before `web build` → static GET returns `503` with build hint,
  ws still mirrors the terminal; build then reload.
- **Bad**: serving the PWA from a *separate* server/port (e.g. `vite preview`) → two origins →
  same-origin `wss` breaks and you need extra `tailscale serve --set-path` mounts + a baked-in
  `VITE_BRIDGE_WS_URL`. Don't; keep it single-origin.

### 6. Tests Required

`bridge/src/ws-server.test.ts` (assertion points):
- `GET /` → 200 + `content-type: text/html` + body is the shell.
- deep navigation route (`Accept: text/html`) → 200 index (SPA fallback), not 404.
- `GET /sw.js` → `cache-control: no-cache`.
- `GET /assets/<hashed>` → `cache-control` contains `immutable`.
- `GET /%2e%2e/config.ts` → 404 (traversal blocked, verified on win32 `\` sep).
- `POST /` → 405 + `Allow` contains `GET`.
- missing `webDist` → 503 + body matches the build hint.
- **ws Upgrade still completes attach→ready→output on the SAME server that serves static**.

### 7. Wrong vs Correct

#### Wrong
```ts
// Two origins: ws on its own port, static elsewhere → same-origin wss breaks,
// SW/HTTPS must be solved twice, tailscale needs multiple --set-path mounts.
new WebSocketServer({ port, host: "0.0.0.0" }); // also: public ingress!
```

#### Correct
```ts
// One loopback http.Server hosts static (GET) + ws (Upgrade); one tailscale
// serve fronts the whole origin; client uses same-origin wss://<host>.
const http = createServer(staticHandler);          // serves web/dist
const wss  = new WebSocketServer({ server: http }); // shares the port
http.listen(port, "127.0.0.1");                     // loopback only — no public ingress
```

**Related**: bracketed-paste / resize-alive / API-key-strip pitfalls live in
`pty-session.ts` (prd §三个 load-bearing 坑); reconnect/replay contract in
`protocol.ts` + `ws-server.ts` (PR2).
