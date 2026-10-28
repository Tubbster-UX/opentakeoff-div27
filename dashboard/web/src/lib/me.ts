// Who is using the app: the Worker's verified Cloudflare Access identity (GET /api/me),
// read once per page load and shared by the header and the schematic editor.
import { useEffect, useState } from "react";
import type { Me } from "../../../src/shared/protocol.js";

let pending: Promise<Me | null> | null = null;

export function loadMe(): Promise<Me | null> {
  pending ??= fetch("/api/me", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
    .catch(() => null);
  return pending;
}

export function useMe(): Me | null | undefined {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadMe().then((m) => live && setMe(m));
    return () => {
      live = false;
    };
  }, []);
  return me;
}
