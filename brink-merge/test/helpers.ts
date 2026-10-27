import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalogMap, type CatalogMap } from "../src/catalog.js";
import { parseInput, type LoadedInput } from "../src/load.js";

export const fixture = (name: string): string => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
export const MAP_PATH = fileURLToPath(new URL("../data/catalog-map.json", import.meta.url));

/** A real OpenTakeoff export pair (fixtures/generate/README.md says how it was made). */
export function load(name: "div27-sample" | "div27-minimal", withReport = true): LoadedInput {
  return parseInput(readFileSync(fixture(`${name}.takeoff.json`), "utf8"), withReport ? readFileSync(fixture(`${name}.report.json`), "utf8") : null);
}

export function catalog(): CatalogMap {
  return loadCatalogMap(MAP_PATH);
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
