# Bridge Approval + Notification (PR4)

> Remote tool-approval round-trip and push notifications for the mobile-remote-control
> MVP. cc's `PreToolUse` (type:http) hook blocks on the bridge; the bridge surfaces the
> request over two channels (ntfy push buttons + PWA card), and returns the human's
> `permissionDecision`. Builds on [Bridge HTTP + WebSocket Serving](./bridge-serving.md).

Code: `bridge/src/{api-server,approval,ntfy,secure-compare,config}.ts`,
`bridge/src/protocol.ts` ⇄ `web/src/protocol.ts`, `bridge/claude-hook.example.json`.

---

## Scenario: cc PreToolUse(http) → bridge → human → permissionDecision

### 1. Scope / Trigger

Triggers code-spec depth on all counts: **new API signatures** (4 HTTP routes + 3 ws
frames), **cross-layer request/response contract** (cc hook ⇄ bridge ⇄ phone/PWA),
**secrets + env wiring** (`BRIDGE_TOKEN`, per-approval nonce, ntfy/approval config).
This is the PR that introduces the **authentication boundary** for the whole system —
get the auth wrong and any tailnet peer can drive or forge approvals for your cc.

### 2. Signatures

HTTP routes — all mounted on the SAME loopback `http.Server` as the PWA + ws, dispatched
BEFORE the static handler, claimed only for these exact paths (`api-server.ts`):

| Method · Path | Auth | Returns |
|---|---|---|
| `POST /hooks/pre-tool-use` | `Authorization: Bearer <BRIDGE_TOKEN>` | `200 {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision,permissionDecisionReason}}` (blocks until decided) |
| `POST /hooks/stop` | Bearer | `200 {}` (pushes "done"; NEVER `decision:block`) |
| `POST /hooks/notification` | Bearer (optional route) | `200 {}` (notify-only) |
| `POST /approvals/<id>?decision=&nonce=` | single-use `nonce` (NOT the token) | `200 {ok:true,...}` / 4xx |

WebSocket Upgrade auth + frames (`protocol.ts`, mirrored in both packages):
- Handshake: `wss://<host>/?token=<BRIDGE_TOKEN>` — `WebSocketServer({ verifyClient })` rejects missing/wrong.
- Down: `approval_request{id,toolName,toolInput:string,createdAt:number}`, `approval_resolved{id,decision}`.
- Up: `approval_decision{id,decision}` (no nonce — the ws was token-authed at handshake).

Core module signatures:
```ts
// api-server.ts — returns true iff it claimed the request (else caller falls through to static)
createApiHandler(opts: ApiHandlerOptions): { handle(req, res): boolean }

// approval.ts — channel-agnostic pending table
class ApprovalRegistry {
  create(toolName: string, toolInput: unknown): PendingApproval  // {id, nonce, promise, createdAt, ...}
  resolve(id, decision, { viaNonce? }): "resolved" | "already-settled" | "unknown" | "bad-nonce"
  onCreated(cb) / onResolved(cb): () => void   // ws-server broadcasts approval_request / approval_resolved
  has(id): boolean;  get pendingCount(): number
}

// ntfy.ts — outbound push only, never throws
class NtfyClient { get enabled; publish(msg: NtfyMessage): Promise<boolean> }

// secure-compare.ts — constant-time secret check (see Convention below)
secureEqual(a: string, b: string): boolean
```

### 3. Contracts

**PreToolUse request (parsed DEFENSIVELY)** — cc field is `tool_name`/`tool_input`
(snake_case); the bridge also accepts camelCase aliases and falls back to placeholders so
a schema drift can never crash the approval path. ⚠️ The exact input AND response schema
were **not** byte-verified for cc v2.1.159 — confirm with `claude --debug` (research
"Caveats"). The response shape above is what the docs specify.

**`PendingApproval`**: `{ id: uuid, nonce: uuid, toolName, toolInput, promise: Promise<decision>, createdAt }`.
`ApprovalDecision = "allow" | "deny" | "ask"`.

**Env keys** (`config.ts` `loadConfig()`):

| Key | Default | Meaning |
|---|---|---|
| `BRIDGE_TOKEN` | random UUID per boot (ephemeral; `tokenIsEphemeral()`→warn) | Shared secret for ws `?token=` AND hook `Bearer`. **Set it** or the capability URL breaks every restart. |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy base for outbound push. |
| `NTFY_TOPIC` | unset | Topic to publish to. **Unset → push skipped** (PWA card still resolves approvals). |
| `APPROVAL_BASE_URL` | unset | Tailnet HTTPS base (`https://<host>.<tailnet>.ts.net`) for ntfy button callback URLs. Unset → push has **no buttons**. Trailing slash stripped. |
| `APPROVAL_TIMEOUT_MS` | `280000` | Wait for a human before fail-closed. **MUST stay < cc hook `timeout` (300s)** so the bridge answers first. |
| `APPROVAL_TIMEOUT_DECISION` | `deny` | Fail-closed default on timeout. |

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| hook POST, missing/malformed/wrong `Bearer` | `401 {error:"unauthorized"}` |
| non-POST on an owned API path | `405` + `Allow: POST` (does NOT fall through to static) |
| hook body > 1 MiB | `413` |
| `/approvals/<id>` missing/invalid `decision` | `400` |
| `/approvals/<id>` missing `nonce` | `401 missing nonce` |
| `/approvals/<id>` wrong `nonce` | `401 invalid nonce` (`resolve`→`bad-nonce`); pending UNCHANGED |
| `/approvals/<id>` valid, first time | `200 {ok,decision}`; promise settles; `approval_resolved` broadcast |
| `/approvals/<id>` valid, already decided | `200 {ok,alreadyResolved}` (idempotent; entry lingers 60s) |
| `/approvals/<id>` unknown / evicted (>60s) | `404` (graceful, not a crash) |
| ws Upgrade, missing/wrong `?token=` | handshake rejected (`verifyClient`) |
| no decision within `APPROVAL_TIMEOUT_MS` | promise settles `deny`; returned before cc's 300s |
| `NTFY_TOPIC` unset | `publish()`→`false` + warn-once; approval still resolvable via ws |
| ntfy push HTTP error / network throw | swallowed → `false` + warn; approval path unaffected |

### 5. Good / Base / Bad Cases

- **Good**: cc wants `Bash`; phone shows ntfy buttons + PWA card; user taps 通过 (either channel) → `/hooks/pre-tool-use` returns `allow` in seconds; the other channel’s late tap → idempotent `already-settled`.
- **Base**: phone offline / nobody home → at 280s the entry resolves `deny`; cc gets a definite decision and continues (tool blocked) — **never hangs to cc's 600s default**.
- **Bad (must be prevented)**: BRIDGE_TOKEN leaking into an ntfy-visible URL; trusting loopback origin (a reverse proxy makes every request loopback); `===` token compare (timing/length leak); returning `decision:block` from Stop (loops cc back into the turn).

### 6. Tests Required (assertion points)

- `approval.test.ts` — `resolve` returns `resolved`/`already-settled`/`unknown`/`bad-nonce`; wrong nonce leaves pending UNCHANGED; timeout settles the fail-closed default (inject `now`/fake timers); `onCreated`/`onResolved` fire.
- `ntfy.test.ts` — topic unset → no fetch, `publish()`→false; JSON publish body carries `topic`/`actions`; non-2xx / throw → false (never throws).
- `secure-compare.test.ts` — equal true; equal-length mismatch false; unequal-length false (no throw); empty; unicode.
- `ws-server.test.ts` (integration) — ws Upgrade rejects missing/wrong token, accepts correct; `/hooks/*` 401 without Bearer; full round-trip resolved via ws `approval_decision` AND via `/approvals` nonce (allow & deny); timeout→deny; Stop pushes & returns `{}`; **routing priority** (GET `/` app shell, `/assets` immutable, `%2e%2e`→404, missing dist→503 all still hold; POST `/hooks` not swallowed by static).
- web `protocol.test.ts` / `approvals.test.ts` — parse/serialize the three approval frames; `ApprovalStore` add→pending, resolve→removed (DOM-free).

### 7. Wrong vs Correct

**(a) Trusting loopback behind tailscale serve**
```ts
// WRONG: tailscale serve reverse-proxies, so EVERY request looks like 127.0.0.1.
if (req.socket.remoteAddress === "127.0.0.1") return true;   // opens the bridge to the whole tailnet
// CORRECT: always require the credential; never auto-trust origin.
return supplied !== undefined && secureEqual(supplied, token);
```

**(b) Secret comparison**
```ts
if (supplied === token) ...                 // WRONG: leaks length + prefix via timing
return secureEqual(supplied, token);        // CORRECT: SHA-256 → timingSafeEqual (length/position independent)
```

**(c) Approval callback capability**
```ts
// WRONG: ntfy.sh sees the action URL → reusable token leaks to a third party.
`${base}/approvals/${id}?token=${BRIDGE_TOKEN}`
// CORRECT: per-approval single-use nonce; the token never enters an ntfy-visible URL.
`${base}/approvals/${id}?decision=allow&nonce=${nonce}`
```

**(d) Where the cc hook config lives** — see `claude-hook.example.json`: it is an
**example**, copied into the **TARGET project's** `.claude/settings.json` (the one passed
as `BRIDGE_CWD`), or `~/.claude/settings.json`. **Never** add it to THIS repo's
`.claude/settings.json` — that holds the Trellis workflow hooks, and would fire (POST a
not-running bridge) every time you run cc here.

---

## Convention: constant-time compare for tailnet-reachable / externally-visible secrets

**What**: Compare any secret an attacker can probe — the `BRIDGE_TOKEN` (reachable over
the tailnet on the ws `?token=` and hook `Bearer`) and the per-approval `nonce` (visible
to ntfy.sh in action URLs) — with `secureEqual` (`secure-compare.ts`), never `===`.

**Why**: V8 string `===` short-circuits on length and on the first differing byte, leaking
the secret's length and a prefix-matching timing oracle. `secureEqual` SHA-256s both sides
to a fixed 32-byte digest before `crypto.timingSafeEqual`, so the compare is independent of
mismatch length AND position.

**Related**: the three call sites are ws `?token=` (`ws-server.ts`), hook `Bearer`
(`api-server.ts isAuthorized`), and the ntfy nonce (`approval.ts resolve`). New
secret checks reachable from the network MUST route through `secureEqual`.

## Gotcha: a push channel must never gate the approval

> **Warning**: ntfy `publish()` is fire-and-forget and **never throws** — a push failure,
> missing `NTFY_TOPIC`, or absent `APPROVAL_BASE_URL` must not block or fail the
> `/hooks/pre-tool-use` await. The PWA card (over the authed ws) is the reliable channel;
> ntfy is best-effort on top. Likewise the bridge timeout (`APPROVAL_TIMEOUT_MS`) MUST be
> shorter than cc's hook `timeout`, or an unanswered approval hangs cc to its 600s default.
