// D-Tools Cloud connection settings, read from the environment (fly secrets).
//
//   DTOOLS_API_KEY         the owner's key (D-Tools: Settings → Integration → Developer).
//                          Unset → D-Tools is not connected; the tools say so.
//   DTOOLS_BASIC_USER      HTTP Basic user and password D-Tools publishes for every API
//   DTOOLS_BASIC_PASSWORD  user in its Postman collection (sent on every request).
//   DTOOLS_WEBHOOK_TOKEN   the Bearer token D-Tools' webhook sends to /webhooks/dtools.
//                          Unset → the webhook receiver refuses everything (503).
//   DTOOLS_BASE_URL        override of the API base (tests); default the D-Tools cloud.
//
// None of these values is ever logged or put in an error message.

export const DTOOLS_BASE_URL = "https://dtcloudapi.d-tools.cloud/api/v1";

export interface DtoolsConfig {
  baseUrl: string;
  apiKey: string;
  basicUser: string | null;
  basicPassword: string | null;
  webhookToken: string | null;
  /** Per-request timeout (default 20 s). */
  timeoutMs: number;
}

export const NOT_CONNECTED = "D-Tools is not connected: add the API key in the server settings (fly secrets set DTOOLS_API_KEY=... DTOOLS_BASIC_USER=... DTOOLS_BASIC_PASSWORD=...; docs/HOSTED.md, \"Connect D-Tools Cloud\").";

const val = (env: Record<string, string | undefined>, k: string): string | null => {
  const v = env[k]?.trim();
  return v ? v : null;
};

/** The D-Tools settings, or null when DTOOLS_API_KEY is unset. */
export function loadDtoolsConfig(env: Record<string, string | undefined> = process.env): DtoolsConfig | null {
  const apiKey = val(env, "DTOOLS_API_KEY");
  if (!apiKey) return null;
  const base = val(env, "DTOOLS_BASE_URL") ?? DTOOLS_BASE_URL;
  if (!/^https?:\/\//i.test(base)) throw new Error("DTOOLS_BASE_URL must start with https://");
  const timeout = Number(val(env, "DTOOLS_TIMEOUT_MS") ?? "");
  return {
    baseUrl: base.replace(/\/+$/, ""),
    apiKey,
    basicUser: val(env, "DTOOLS_BASIC_USER"),
    basicPassword: val(env, "DTOOLS_BASIC_PASSWORD"),
    webhookToken: val(env, "DTOOLS_WEBHOOK_TOKEN"),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 20_000,
  };
}

/** The webhook token alone (the receiver needs it even when the API key is unset). */
export function loadWebhookToken(env: Record<string, string | undefined> = process.env): string | null {
  return val(env, "DTOOLS_WEBHOOK_TOKEN");
}
