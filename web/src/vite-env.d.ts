/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for the bridge WebSocket URL (e.g. ws://127.0.0.1:8866). */
  readonly VITE_BRIDGE_WS_URL?: string;
  /**
   * Optional dev-only capability token, used when you open the PWA without a
   * `?token=` query (the bridge prints the capability URL on startup). The URL /
   * localStorage token takes priority over this. (PR4)
   */
  readonly VITE_BRIDGE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
