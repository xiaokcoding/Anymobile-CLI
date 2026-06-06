/**
 * ntfy outbound push (PR4, prd 技术方案 + research/pwa-tailscale-webpush.md §5).
 *
 * The bridge POSTs notifications to an ntfy server (default https://ntfy.sh) using
 * ntfy's JSON-publishing form so we can attach `http` action buttons. For an
 * approval, the two buttons (allow/deny) POST back to the bridge's `/approvals/<id>`
 * with a single-use `nonce` (the long-lived BRIDGE_TOKEN is NEVER put in a URL that
 * ntfy.sh can see — see approval.ts). Android and the iOS ntfy app both render
 * these buttons, which is why ntfy is the MVP notification channel rather than Web
 * Push (no iOS notification-action buttons; research §3.3 / §5.3).
 *
 * Everything here is OUTBOUND POST only — no inbound port is opened, so this does
 * not touch the "no public ingress" DoD (.trellis/spec/backend/bridge-serving.md).
 *
 * Skips (with a warning, never throws to the caller) when NTFY_TOPIC is unset:
 * approvals still resolve via the PWA card, so a missing ntfy config must not make
 * the approval path fail.
 */

/** One ntfy action button (we only use the `http` kind to call back the bridge). */
export interface NtfyAction {
  readonly action: "http";
  readonly label: string;
  readonly url: string;
  readonly method?: "GET" | "POST";
  /** Dismiss the notification after the action fires. */
  readonly clear?: boolean;
}

export interface NtfyMessage {
  readonly title?: string;
  readonly message: string;
  /** ntfy priority 1 (min) – 5 (max). Approvals use 5 (urgent). */
  readonly priority?: 1 | 2 | 3 | 4 | 5;
  readonly tags?: readonly string[];
  readonly actions?: readonly NtfyAction[];
}

export interface NtfyClientOptions {
  /** Base URL of the ntfy server (default https://ntfy.sh). */
  readonly server: string;
  /** Topic to publish to; when undefined, publish() is a no-op + warn. */
  readonly topic: string | undefined;
  /** Optional fetch injection for tests (defaults to global fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Optional warning sink (defaults to console.warn). */
  readonly warn?: (message: string) => void;
}

export class NtfyClient {
  private readonly server: string;
  private readonly topic: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly warn: (message: string) => void;
  /** Warn only once about a missing topic so we don't spam the logs per push. */
  private warnedNoTopic = false;

  constructor(options: NtfyClientOptions) {
    // Drop a trailing slash so `${server}/${topic}` never double-slashes.
    this.server = options.server.endsWith("/") ? options.server.slice(0, -1) : options.server;
    this.topic = options.topic;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.warn = options.warn ?? ((m) => console.warn(`[mobile-ssh] ${m}`));
  }

  /** True when a topic is configured (pushes will actually be sent). */
  get enabled(): boolean {
    return this.topic !== undefined;
  }

  /**
   * Publish a notification. Resolves true on a 2xx response, false on any failure
   * or when disabled (no topic). Never throws — a push failure must not break the
   * approval round-trip (the PWA card is the reliable channel).
   */
  async publish(msg: NtfyMessage): Promise<boolean> {
    if (this.topic === undefined) {
      if (!this.warnedNoTopic) {
        this.warn("NTFY_TOPIC unset — skipping push (approvals still work via the PWA card).");
        this.warnedNoTopic = true;
      }
      return false;
    }

    // ntfy JSON publishing: POST the message body to the server root with `topic`
    // in the JSON (https://docs.ntfy.sh/publish/#publish-as-json).
    const body = JSON.stringify({
      topic: this.topic,
      title: msg.title,
      message: msg.message,
      priority: msg.priority,
      tags: msg.tags,
      actions: msg.actions,
    });

    try {
      const res = await this.fetchImpl(this.server, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        this.warn(`ntfy push failed: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.warn(`ntfy push error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
