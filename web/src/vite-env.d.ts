/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for the bridge WebSocket URL (e.g. ws://127.0.0.1:8866). */
  readonly VITE_BRIDGE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
