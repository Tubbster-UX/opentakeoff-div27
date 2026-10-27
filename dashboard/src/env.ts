export interface Env {
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
}
