/**
 * Pure input-box submit logic — no DOM, so it's unit testable in isolation
 * (web/src/input-box.test.ts). The DOM wiring (textarea, send button, IME
 * composition listeners) lives in main.ts; the "should this keystroke submit?"
 * and "what do we actually send to the PTY?" decisions live here.
 *
 * Why a separate input box at all (prd Requirements + research §1):
 *   - The mobile terminal needs a real, focusable text field. Typing directly
 *     into xterm.js's hidden textarea is the desktop input path, but on mobile
 *     it's fiddly and — critically — iOS dictation / IME double-types into a raw
 *     xterm.js (a known xterm.js IME behaviour, research §1). A dedicated input
 *     box sidesteps both.
 *   - We never feed the PTY during composition (pinyin/IME): only the FINAL
 *     committed text is sent, so composing characters can't leak through twice.
 *
 * The bridge already feeds the PTY char-by-char with a delay (PR1 bracketed-paste
 * fix), so the client sends the whole line at once — `text + "\r"` — and lets the
 * bridge re-chunk it. The trailing `\r` is what makes Claude actually submit the
 * prompt (research §1: the bracketed-paste bug that PR1 fixed).
 */

/** Carriage return — what Claude's TUI reads as "submit this prompt". */
export const SUBMIT_KEY = "\r";

/**
 * Decide whether an Enter keypress in the input box should submit.
 *
 * Rules:
 *   - While an IME composition is active (`composing`), Enter belongs to the
 *     IME (e.g. selecting a pinyin candidate) — never submit.
 *   - Shift+Enter inserts a newline instead of submitting, matching chat-app
 *     muscle memory (the textarea grows; the literal newline is part of the
 *     prompt when the user finally submits).
 *   - A plain Enter (no modifiers, not composing) submits.
 *
 * `key` / `shiftKey` mirror the relevant `KeyboardEvent` fields so this is
 * testable without a real DOM event.
 */
export function shouldSubmit(
  event: { key: string; shiftKey: boolean },
  composing: boolean,
): boolean {
  if (composing) return false;
  if (event.key !== "Enter") return false;
  if (event.shiftKey) return false;
  return true;
}

/**
 * Build the wire payload for a submitted prompt, or `null` if there's nothing to
 * send. Whitespace-only / empty input is dropped (no point waking the PTY with a
 * bare `\r`). Otherwise we send the text verbatim plus a trailing `\r` so Claude
 * submits it.
 *
 * Note: we intentionally do NOT trim the user's text content (leading/trailing
 * spaces inside a prompt can be meaningful) — we only check `trim()` to decide
 * whether the field is effectively empty.
 */
export function buildSubmitPayload(text: string): string | null {
  if (text.trim().length === 0) return null;
  return text + SUBMIT_KEY;
}
