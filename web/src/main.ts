import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { BridgeClient } from "./bridge-client.js";
import { shouldSubmit, buildSubmitPayload } from "./input-box.js";

// PR1: mount xterm.js and wire it to the bridge over WebSocket.
// PR3 adds the mobile input box, PWA manifest/service-worker, and tailscale HTTPS.
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

const el = document.getElementById("terminal");
if (el) {
  term.open(el);
  fit.fit();

  const client = new BridgeClient({ url: resolveBridgeUrl(), term, fit });
  client.connect();

  wireInputBox(client, term);
}

// Register the service worker (PWA installability + offline shell). Must run in
// a secure context — over plain http://<tailscale-ip> the registration throws,
// so we guard on isSecureContext (localhost and https both qualify; bare
// http://100.x does not). Failure is non-fatal: the terminal still works.
registerServiceWorker();

/**
 * Resolve the bridge WebSocket URL.
 *
 * - Dev: defaults to ws://127.0.0.1:8866 (the bridge's default BRIDGE_PORT).
 * - Behind tailscale serve (PR3): defaults to wss://<same-host> so the secure
 *   context is preserved.
 * - Override anytime with VITE_BRIDGE_WS_URL.
 */
function resolveBridgeUrl(): string {
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
