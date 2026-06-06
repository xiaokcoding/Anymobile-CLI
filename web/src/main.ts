import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { BridgeClient } from "./bridge-client.js";
import { shouldSubmit, buildSubmitPayload } from "./input-box.js";
import { ApprovalStore } from "./approvals.js";
import type { ApprovalDecision } from "./protocol.js";

// PR1: mount xterm.js and wire it to the bridge over WebSocket.
// PR3 adds the mobile input box, PWA manifest/service-worker, and tailscale HTTPS.
// PR4 adds the capability-URL token + approval cards.
const term = new Terminal({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 13,
  cursorBlink: true,
  // Match common 256-color terminals for ANSI fidelity.
  allowProposedApi: true,
  theme: { background: "#1e1e1e" },
});

const fit = new FitAddon();
term.loadAddon(fit);

// PR4: capture the capability-URL token BEFORE anything else uses the URL, so we
// can strip it from the address bar immediately (don't let it sit in history /
// get cached by the SW). Stored in localStorage so the home-screen PWA keeps
// working without the query on subsequent launches.
const token = captureToken();

const el = document.getElementById("terminal");
if (el) {
  term.open(el);
  fit.fit();

  const approvals = new ApprovalStore();
  const client = new BridgeClient({
    url: resolveBridgeUrl(token),
    term,
    fit,
    onApprovalRequest: (req) => {
      approvals.add(req);
      renderApprovals(approvals, client);
    },
    onApprovalResolved: (id) => {
      approvals.resolve(id);
      decidedIds.delete(id);
      renderApprovals(approvals, client);
    },
  });
  client.connect();

  wireInputBox(client, term);
}

// Register the service worker (PWA installability + offline shell). Must run in
// a secure context — over plain http://<tailscale-ip> the registration throws,
// so we guard on isSecureContext (localhost and https both qualify; bare
// http://100.x does not). Failure is non-fatal: the terminal still works.
registerServiceWorker();

/**
 * Capture the capability-URL token: read `?token=` once, persist it in
 * localStorage, and strip it from the address bar via history.replaceState so it
 * never lingers in history, gets shared in a screenshot, or is cached by the SW
 * (which only caches GET navigations to the bare path). Returns the effective
 * token (from the URL if present, else the previously-stored one, else "").
 *
 * In dev you can also set VITE_BRIDGE_TOKEN; the URL/localStorage take priority.
 */
function captureToken(): string {
  let stored = "";
  try {
    stored = window.localStorage.getItem("bridgeToken") ?? "";
  } catch {
    // localStorage can throw in private mode / disabled storage; tolerate it.
  }

  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    stored = fromUrl;
    try {
      window.localStorage.setItem("bridgeToken", fromUrl);
    } catch {
      // ignore storage failures — we still use the in-memory value this session
    }
    // Strip ?token= from the URL without a navigation (keeps the SW from caching it).
    params.delete("token");
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", clean);
  }

  return stored || (import.meta.env.VITE_BRIDGE_TOKEN ?? "");
}

/**
 * Resolve the bridge WebSocket URL, appending the capability token as `?token=`
 * (PR4 ws handshake auth). The bridge rejects a ws Upgrade without a matching
 * token; loopback is NOT auto-trusted (tailscale serve makes everything look
 * like loopback).
 *
 * - Dev: defaults to ws://127.0.0.1:8866 (the bridge's default BRIDGE_PORT).
 * - Behind tailscale serve (PR3): defaults to wss://<same-host> so the secure
 *   context is preserved.
 * - Override the base anytime with VITE_BRIDGE_WS_URL.
 */
function resolveBridgeUrl(token: string): string {
  const base = resolveBridgeBase();
  if (!token) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

function resolveBridgeBase(): string {
  const override = import.meta.env.VITE_BRIDGE_WS_URL;
  if (override) return override;

  if (import.meta.env.DEV) return "ws://127.0.0.1:8866";

  // Production build served by the bridge/tailscale: reuse page origin.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

/**
 * Wire the mobile input box (textarea + send button) to the bridge.
 *
 * This is the mobile-primary input path: typing into xterm.js's hidden textarea
 * is fiddly on phones and IME/dictation double-types into a raw xterm.js
 * (research §1). The dedicated box sends only the FINAL committed line, so
 * composing characters can never leak through twice. The submit/IME decision is
 * the pure `shouldSubmit` / `buildSubmitPayload` (input-box.ts) so it's unit
 * tested without a DOM.
 *
 * The desktop path (xterm.js `term.onData`, wired in BridgeClient) stays live —
 * both producers send the same `{ type: "input", data }` envelope. The two paths
 * don't double-send: keystrokes typed in the textarea go to the textarea's value
 * and are only forwarded on submit; they never reach xterm.js's onData.
 */
function wireInputBox(client: BridgeClient, term: Terminal): void {
  const input = document.getElementById("prompt-input") as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById("send-btn") as HTMLButtonElement | null;
  if (!input || !sendBtn) return;

  // IME composition guard: while composing (pinyin/IME, iOS dictation), Enter
  // belongs to candidate selection — never submit, never forward.
  let composing = false;
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });

  const submit = (): void => {
    const payload = buildSubmitPayload(input.value);
    if (payload === null) return; // empty / whitespace-only
    client.sendInput(payload);
    input.value = "";
    // Keep focus so the user can fire off prompts in a row, and refocus the
    // terminal viewport so scroll/keys land sensibly afterwards.
    input.focus();
    term.scrollToBottom();
  };

  input.addEventListener("keydown", (ev) => {
    if (shouldSubmit(ev, composing)) {
      ev.preventDefault(); // don't insert the newline we're consuming as submit
      submit();
    }
  });

  sendBtn.addEventListener("click", () => submit());
}

/**
 * Ids the user has tapped allow/deny on locally but whose `approval_resolved`
 * hasn't round-tripped yet. Tracked at module scope (not in the DOM) so that a
 * re-render — triggered when ANOTHER approval arrives in the brief window between
 * tap and resolve — keeps an already-decided card's buttons disabled instead of
 * resurrecting them enabled. The bridge's resolve() is idempotent regardless, so
 * this is belt-and-suspenders against a redundant second `approval_decision`.
 * Cleared on `approval_resolved` (see onApprovalResolved).
 */
const decidedIds = new Set<string>();

/**
 * Render the pending approval cards (PR4). Each card shows the tool name + a
 * short input preview and two buttons (通过 / 拒绝). Tapping a button sends an
 * `approval_decision` over the (already token-authed) ws; the bridge resolves the
 * pending approval and broadcasts `approval_resolved`, which removes the card via
 * `onApprovalResolved` → this same render. We disable the buttons on tap so a
 * double-tap can't fire twice before the resolve round-trips, and remember the
 * decided id (decidedIds) so a re-render in that window keeps them disabled.
 *
 * The cards live in a fixed overlay above the input bar so they don't disturb the
 * terminal/input flex layout (index.html #approvals). When there are none the
 * overlay is empty (and invisible via :empty CSS).
 */
function renderApprovals(store: ApprovalStore, client: BridgeClient): void {
  const container = document.getElementById("approvals");
  if (!container) return;

  // Rebuild from scratch each change — the set is tiny (usually 0–1 pending).
  container.replaceChildren();

  for (const approval of store.list()) {
    const card = document.createElement("div");
    card.className = "approval-card";

    const title = document.createElement("div");
    title.className = "approval-title";
    title.textContent = `审批：${approval.toolName}`;
    card.appendChild(title);

    const preview = document.createElement("div");
    preview.className = "approval-preview";
    preview.textContent = approval.toolInput;
    card.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "approval-actions";

    const decide = (decision: ApprovalDecision): void => {
      // Disable both buttons immediately so a double-tap can't double-send, and
      // remember this id so a re-render before the resolve keeps it disabled.
      decidedIds.add(approval.id);
      for (const b of actions.querySelectorAll("button")) {
        (b as HTMLButtonElement).disabled = true;
      }
      client.sendApprovalDecision(approval.id, decision);
    };

    const alreadyDecided = decidedIds.has(approval.id);

    const allowBtn = document.createElement("button");
    allowBtn.type = "button";
    allowBtn.className = "approval-allow";
    allowBtn.textContent = "通过";
    allowBtn.disabled = alreadyDecided;
    allowBtn.addEventListener("click", () => decide("allow"));

    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "approval-deny";
    denyBtn.textContent = "拒绝";
    denyBtn.disabled = alreadyDecided;
    denyBtn.addEventListener("click", () => decide("deny"));

    actions.append(allowBtn, denyBtn);
    card.appendChild(actions);
    container.appendChild(card);
  }
}

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  // Over a non-secure context (e.g. http://100.x tailscale IP) the registration
  // would reject; skip rather than throw an unhandled rejection.
  if (!window.isSecureContext) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Non-fatal: the app works without offline caching / installability.
      console.warn("[mobile-ssh] service worker registration failed:", err);
    });
  });
}
