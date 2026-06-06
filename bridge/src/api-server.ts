/**
 * HTTP API handlers for PR4: cc hook endpoints + ntfy http-action callbacks.
 *
 * These mount on the SAME loopback http.Server that serves the PWA and the ws
 * (.trellis/spec/backend/bridge-serving.md: single origin, 127.0.0.1 only, no
 * second port). The ws-server routes matching method+path here BEFORE the static
 * handler, so static behaviour (app-shell fallback, /sw.js no-cache, /assets
 * immutable, traversal guard, 503) is untouched.
 *
 * Endpoints:
 *   POST /hooks/pre-tool-use   (Bearer-authed) — cc's PreToolUse(type:http) hook.
 *       Blocks until a human (or the fail-closed timeout) decides, then returns
 *       the PreToolUse permissionDecision JSON cc expects. (research §2.2)
 *   POST /hooks/stop           (Bearer-authed) — cc's Stop hook. Pushes a "done"
 *       notification and returns {} (NEVER decision:block). (research §3)
 *   POST /hooks/notification   (Bearer-authed, optional) — cc's Notification hook
 *       (idle_prompt / permission_prompt). Notify-only, returns {}.
 *   POST /approvals/<id>?decision=&nonce=  (nonce-authed) — ntfy http-action
 *       button callback. Resolves the pending approval by single-use nonce.
 *
 * AUTH NOTE (security): cc hooks use `Authorization: Bearer <BRIDGE_TOKEN>` (the
 * same shared secret as the ws capability URL). The ntfy callback uses a per-
 * request single-use nonce, NOT the token, because ntfy.sh sees the action URLs
 * (approval.ts). Loopback-origin requests are NOT auto-trusted: tailscale serve
 * reverse-proxies make every request look like loopback to the bridge, so we
 * always require the credential. (dispatch constraint 2; research R2 §2.3)
 *
 * SCHEMA CAVEAT: the exact cc PreToolUse hook input AND the http-hook response
 * schema are documented but evolve fast and were not byte-verified for cc
 * v2.1.159 — research/claude-code-hooks-approval.md "Caveats" says to confirm
 * with `claude --debug`. We therefore parse the hook input DEFENSIVELY (any
 * missing field falls back to a safe placeholder) and emit the response shape the
 * docs give (`hookSpecificOutput.permissionDecision`). Re-verify against a real
 * --debug round-trip before trusting in production.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalRegistry, ApprovalDecision } from "./approval.js";
import type { NtfyClient, NtfyAction } from "./ntfy.js";
import { secureEqual } from "./secure-compare.js";

export interface ApiHandlerOptions {
  /** Shared secret for `Authorization: Bearer` on the cc hook endpoints. */
  readonly token: string;
  readonly approvals: ApprovalRegistry;
  readonly ntfy: NtfyClient;
  /**
   * Public base URL the phone reaches the bridge at (tailscale serve), used to
   * build ntfy http-action button URLs. Undefined → push has no buttons.
   */
  readonly approvalBaseUrl: string | undefined;
  /** Max request body bytes accepted on a hook POST (defensive cap). */
  readonly maxBodyBytes?: number;
  readonly warn?: (message: string) => void;
}

/** Default body cap — cc hook payloads are small JSON; reject anything absurd. */
const DEFAULT_MAX_BODY = 1024 * 1024;

/** How many chars of the tool input we surface in the card / push (rest elided). */
const TOOL_INPUT_SUMMARY_LEN = 500;

/**
 * Build an HTTP request handler for the PR4 API. Returns a function that returns
 * `true` when it has handled the request, or `false` to let the caller fall
 * through to the static file handler. Only POST routes are claimed.
 */
export function createApiHandler(options: ApiHandlerOptions): {
  /** True if this request was an API route (and a response was or will be sent). */
  handle: (req: IncomingMessage, res: ServerResponse) => boolean;
} {
  const warn = options.warn ?? ((m) => console.warn(`[mobile-ssh] ${m}`));
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  const handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    // Only these exact paths are API routes; everything else falls through to static.
    const isHook =
      pathname === "/hooks/pre-tool-use" ||
      pathname === "/hooks/stop" ||
      pathname === "/hooks/notification";
    const isApproval = pathname.startsWith("/approvals/");
    if (!isHook && !isApproval) return false;

    // All API routes are POST. A wrong method on a real API path is a 405 (we own
    // the path, so we don't fall through to static which would 404/serve a file).
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
      return true;
    }

    if (isApproval) {
      handleApprovalCallback(req, res, url, options.approvals, warn);
      return true;
    }

    // cc hook routes: Bearer auth first.
    if (!isAuthorized(req, options.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return true;
    }

    void readBody(req, maxBody)
      .then((body) => {
        if (body === null) {
          sendJson(res, 413, { error: "payload too large" });
          return;
        }
        switch (pathname) {
          case "/hooks/pre-tool-use":
            return handlePreToolUse(res, body, options, warn);
          case "/hooks/stop":
            return handleStop(res, body, options.ntfy, warn);
          case "/hooks/notification":
            return handleNotification(res, body, options.ntfy, warn);
        }
      })
      .catch((err) => {
        warn(`hook handler error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
    return true;
  };

  return { handle };
}

/**
 * POST /hooks/pre-tool-use — the blocking approval. Registers a pending approval,
 * surfaces it via ntfy (with allow/deny buttons) AND a ws broadcast (done by the
 * caller-supplied registry listener), then awaits the human/timeout decision and
 * returns the PreToolUse permissionDecision JSON.
 */
async function handlePreToolUse(
  res: ServerResponse,
  body: string,
  options: ApiHandlerOptions,
  warn: (m: string) => void,
): Promise<void> {
  const parsed = parseHookInput(body);
  const toolName = parsed.toolName;
  const toolInput = parsed.toolInput;

  const approval = options.approvals.create(toolName, toolInput);
  const summary = summariseToolInput(toolInput);

  // Channel (a): ntfy push with two single-use-nonce http-action buttons. Fire
  // and forget — a push failure must NOT block or fail the approval (the PWA card
  // is the reliable channel). The ws broadcast (channel b) is wired by the caller.
  if (options.approvalBaseUrl) {
    const actions = buildApprovalActions(options.approvalBaseUrl, approval.id, approval.nonce);
    void options.ntfy.publish({
      title: "Claude 需要审批",
      message: `${toolName}: ${summary}`,
      priority: 5,
      tags: ["lock"],
      actions,
    });
  } else {
    // No base URL → we can't build callback buttons; still push a plain notice so
    // the human knows to open the PWA card.
    void options.ntfy.publish({
      title: "Claude 需要审批",
      message: `${toolName}: ${summary}（打开 App 审批）`,
      priority: 5,
      tags: ["lock"],
    });
  }

  // Block until a human decides via any channel, or the fail-closed timeout fires.
  const decision = await approval.promise;

  // Respond in the shape cc's PreToolUse http hook expects. SCHEMA CAVEAT: verify
  // against `claude --debug` for the installed cc version (see file header).
  sendJson(res, 200, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reasonFor(decision),
    },
  });
  warn(`pre-tool-use ${toolName} → ${decision}`);
}

/**
 * POST /hooks/stop — cc finished a turn. Push a "done" notice (best-effort) and
 * return {} — never decision:block, or we'd loop cc back into the conversation.
 */
async function handleStop(
  res: ServerResponse,
  body: string,
  ntfy: NtfyClient,
  warn: (m: string) => void,
): Promise<void> {
  const parsed = parseStopInput(body);
  void ntfy.publish({
    title: "Claude 完成",
    message: parsed.lastMessage ? truncate(parsed.lastMessage, 300) : "本轮已完成。",
    priority: 3,
    tags: ["white_check_mark"],
  });
  sendJson(res, 200, {});
  warn("stop hook → notified");
}

/**
 * POST /hooks/notification — cc Notification hook (idle_prompt / permission_prompt).
 * Notify-only; return {}. (Optional endpoint; main approval path is pre-tool-use.)
 */
async function handleNotification(
  res: ServerResponse,
  body: string,
  ntfy: NtfyClient,
  warn: (m: string) => void,
): Promise<void> {
  const parsed = parseNotificationInput(body);
  const isPermission = parsed.notificationType === "permission_prompt";
  void ntfy.publish({
    title: isPermission ? "Claude 需要审批" : "Claude 在等你",
    message: parsed.message ?? (isPermission ? "需要你审批" : "在等你输入"),
    priority: isPermission ? 4 : 3,
    tags: [isPermission ? "raised_hand" : "hourglass"],
  });
  sendJson(res, 200, {});
  warn(`notification hook (${parsed.notificationType ?? "?"}) → notified`);
}

/**
 * POST /approvals/<id>?decision=&nonce= — ntfy http-action button callback.
 * Resolves the pending approval by single-use nonce (NOT the bridge token).
 */
function handleApprovalCallback(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  approvals: ApprovalRegistry,
  warn: (m: string) => void,
): void {
  const id = decodeURIComponent(url.pathname.slice("/approvals/".length));
  const decisionRaw = url.searchParams.get("decision");
  const nonce = url.searchParams.get("nonce") ?? undefined;

  if (!id || !isApprovalDecision(decisionRaw)) {
    sendJson(res, 400, { error: "bad request" });
    return;
  }
  if (nonce === undefined) {
    // The nonce is mandatory for this channel — without it the URL would be a
    // bare capability we don't want ntfy.sh-visible links to be.
    sendJson(res, 401, { error: "missing nonce" });
    return;
  }

  const status = approvals.resolve(id, decisionRaw, { viaNonce: nonce });
  switch (status) {
    case "resolved":
      sendJson(res, 200, { ok: true, decision: decisionRaw });
      warn(`approval ${id} → ${decisionRaw} (ntfy)`);
      return;
    case "already-settled":
      // Idempotent: a retry / double-tap after the human already answered.
      sendJson(res, 200, { ok: true, alreadyResolved: true });
      return;
    case "bad-nonce":
      sendJson(res, 401, { error: "invalid nonce" });
      return;
    case "unknown":
      // Unknown or long-evicted id — friendly, not a hard error (the approval may
      // have already resolved and been cleaned up).
      sendJson(res, 404, { error: "no such pending approval" });
      return;
  }
}

// --- helpers ----------------------------------------------------------------

/** Build the two ntfy http-action buttons (allow/deny) carrying the single-use nonce. */
export function buildApprovalActions(baseUrl: string, id: string, nonce: string): NtfyAction[] {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const u = (decision: ApprovalDecision): string =>
    `${base}/approvals/${encodeURIComponent(id)}?decision=${decision}&nonce=${encodeURIComponent(nonce)}`;
  return [
    { action: "http", label: "通过", url: u("allow"), method: "POST", clear: true },
    { action: "http", label: "拒绝", url: u("deny"), method: "POST", clear: true },
  ];
}

/** `Authorization: Bearer <token>` check (constant-time; tokens are UUIDs). */
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const supplied = m?.[1];
  // Constant-time compare so a wrong token can't be probed byte-by-byte by timing.
  return supplied !== undefined && secureEqual(supplied, token);
}

/** Read up to `maxBytes` of the request body; null if the cap is exceeded. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Send a JSON response with the given status. */
function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

interface ParsedHookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
}

/**
 * Defensive parse of a PreToolUse hook body. cc's field is `tool_name`/`tool_input`
 * (snake_case) per the docs, but we accept a couple of camelCase aliases and fall
 * back to placeholders so a schema drift can never crash the approval path
 * (research "Caveats": verify via --debug).
 */
function parseHookInput(body: string): ParsedHookInput {
  const obj = safeJsonObject(body);
  const toolName =
    pickString(obj, "tool_name") ?? pickString(obj, "toolName") ?? "(unknown tool)";
  const toolInput = obj["tool_input"] ?? obj["toolInput"] ?? null;
  return { toolName, toolInput };
}

interface ParsedStopInput {
  readonly lastMessage: string | undefined;
}

function parseStopInput(body: string): ParsedStopInput {
  const obj = safeJsonObject(body);
  const lastMessage =
    pickString(obj, "last_assistant_message") ?? pickString(obj, "lastAssistantMessage");
  return { lastMessage };
}

interface ParsedNotificationInput {
  readonly message: string | undefined;
  readonly notificationType: string | undefined;
}

function parseNotificationInput(body: string): ParsedNotificationInput {
  const obj = safeJsonObject(body);
  return {
    message: pickString(obj, "message"),
    notificationType: pickString(obj, "notification_type") ?? pickString(obj, "notificationType"),
  };
}

function safeJsonObject(body: string): Record<string, unknown> {
  try {
    const v = JSON.parse(body) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Compact, human-readable one-liner of arbitrary tool input for the card/push. */
export function summariseToolInput(input: unknown): string {
  if (input === null || input === undefined) return "(no input)";
  let s: string;
  if (typeof input === "string") {
    s = input;
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  return truncate(s.replace(/\s+/g, " ").trim(), TOOL_INPUT_SUMMARY_LEN);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function reasonFor(decision: ApprovalDecision): string {
  switch (decision) {
    case "allow":
      return "Approved from mobile.";
    case "deny":
      return "Denied from mobile (or timed out).";
    case "ask":
      return "Deferred to the local prompt.";
  }
}

function isApprovalDecision(value: unknown): value is ApprovalDecision {
  return value === "allow" || value === "deny" || value === "ask";
}
