import type { AccessEnv } from "./access.js";

export interface Env extends AccessEnv {
  /** Hyperdrive in front of the Supabase Postgres (session pooler or direct). Locally: localConnectionString. */
  HYPERDRIVE: Hyperdrive;
  /** Static assets (dist/), the single-page app. */
  ASSETS: Fetcher;
  /** The relay Durable Object (one instance holds the Realtime subscription). */
  RELAY: DurableObjectNamespace;
  /** Supabase project URL, e.g. https://<ref>.supabase.co (local: http://127.0.0.1:54321). */
  SUPABASE_URL?: string;
  /** Service-role key: a Worker secret. Used only by the relay to subscribe; never sent to the browser. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Cloudflare Access team domain, https://<team>.cloudflareaccess.com (the JWT issuer). Required for writes. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's Application Audience (AUD) tag. Required for writes. */
  ACCESS_AUD?: string;
  /**
   * LOCAL DEVELOPMENT ONLY (.dev.vars). Attributes writes to this email without Access, but only when Access is
   * not configured and the request came in on a loopback host (src/access.ts). Never set it in wrangler.toml.
   */
  DEV_ONLY_ACCESS_BYPASS_EMAIL?: string;
}
