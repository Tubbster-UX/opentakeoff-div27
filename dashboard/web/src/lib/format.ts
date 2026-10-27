export const fmt = (v: unknown, digits = 2): string =>
  v == null || v === "" ? "" : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits });

export const short = (id: unknown): string => (typeof id === "string" ? id.slice(0, 8) : "");

export const when = (v: unknown): string => {
  if (!v) return "";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};

export const str = (v: unknown): string => (v == null ? "" : String(v));
