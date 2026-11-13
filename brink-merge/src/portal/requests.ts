// Every Portal request brink-merge can make, built in one place so the dry-run
// plan and the live push are the same requests. Only endpoints observed in the
// owner's captures are here (docs/portal-push.md lists them). There is
// deliberately no builder for sending, finalizing, emailing or re-statusing a
// proposal, and none for customer assignment: those are never called.

export const DEFAULT_BASE_URL = "https://api.portal.io";
/** The web app build observed in the captures; override with PORTAL_APP_VERSION or --app-version. */
export const OBSERVED_APP_VERSION = "2026.10.23.1";

export interface PortalConfig {
  baseUrl: string;
  appVersion: string;
}

/** A value Portal returns at run time, shown as <name> in the dry-run plan. */
export type Val<T> = T | `<${string}>`;

export interface PortalRequest {
  method: "GET" | "POST";
  path: string;
  /** Query parameters before appVersion; null = a bare flag (?skipInterceptors). */
  query: [string, string | null][];
  /** false for login / refresh (no Authorization header). */
  auth: boolean;
  headers?: Record<string, string>;
  body?: unknown;
  /** Bodies that carry a secret (login, refresh) are never printed. */
  secretBody?: boolean;
}

export function requestUrl(cfg: PortalConfig, r: PortalRequest): string {
  const q = [...r.query, ["appVersion", cfg.appVersion] as [string, string]]
    .map(([k, v]) => (v === null ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`))
    .join("&");
  return `${cfg.baseUrl.replace(/\/+$/, "")}${r.path}?${q}`;
}

export const loginRequest = (userName: string, password: string): PortalRequest => ({
  method: "POST", path: "/authenticate/login", query: [["skipInterceptors", null]], auth: false, body: { userName, password }, secretBody: true,
});

export const refreshRequest = (refreshToken: string): PortalRequest => ({
  method: "POST", path: "/access-token", query: [["skipInterceptors", null]], auth: false, body: { refreshToken, useTokenCookie: false }, secretBody: true,
});

export const basicInfoRequest = (partId: number): PortalRequest => ({
  method: "GET", path: `/products/basicinfo/${partId}`, query: [], auth: true,
});

export const createProposalRequest = (name: string): PortalRequest => ({
  method: "POST", path: "/proposals", query: [], auth: true, body: { name },
});

export const getProposalRequest = (proposalId: Val<number>): PortalRequest => ({
  method: "GET",
  path: `/proposals/${proposalId}`,
  query: [["excludeDescriptions", "true"], ["frameOnly", "true"], ["showAreaOptionDescription", "true"]],
  auth: true,
});

export const addAreaRequest = (proposalId: Val<number>, name: string, lastModified: Val<string>): PortalRequest => ({
  method: "POST", path: `/proposals/${proposalId}/area`, query: [], auth: true, headers: { "If-Unmodified-Since": lastModified }, body: { name },
});

export interface PartPrice {
  supplierId: Val<number | string>;
  cost: Val<number>;
  sellPrice: Val<number>;
}

/** One Part per request: only single-item requests were observed. */
export const addPartItemRequest = (proposalId: Val<number>, partId: number, price: PartPrice, proposalAreaOptionId: Val<number>, itemQuantity: number): PortalRequest => ({
  method: "POST",
  path: `/proposals/${proposalId}/items`,
  query: [],
  auth: true,
  body: {
    items: [{
      referencedItemId: partId,
      itemType: "Part",
      supplierId: price.supplierId,
      cost: price.cost,
      sellPrice: price.sellPrice,
      proposalAreaOptions: [{ proposalAreaOptionId, itemQuantity }],
      isSupplierChanged: false,
      setDefaultSellPrice: false,
      parentProposalItemIds: [],
    }],
    includeAttachments: true,
  },
});

/** Adjustments (not used by the push plan today; kept to the observed flags). */
export const setItemQtyRequest = (proposalId: number, proposalItemId: number, quantity: number): PortalRequest => ({
  method: "POST", path: `/proposals/${proposalId}/items/${proposalItemId}/qty`, query: [], auth: true, body: { quantity, includeAttachments: false },
});

export const setItemSellPriceRequest = (proposalId: number, proposalItemId: number, sellPrice: number): PortalRequest => ({
  method: "POST", path: `/proposals/${proposalId}/items/${proposalItemId}/sellprice`, query: [], auth: true, body: { sellPrice, setDefault: false, updateAllInstances: false },
});
