/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override the bridge URL. Normally unset — see resolveWsUrl in net/client.ts. */
  readonly VITE_GCS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
