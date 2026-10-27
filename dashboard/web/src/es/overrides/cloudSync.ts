// Brink override of EasySchematic's src/cloudSync.ts (vendor/PATCHES.md):
// no EasySchematic cloud. The project schematic loads from and saves to the
// Brink database (web/src/es/sync.ts).
import type { CachedSchematic } from "../../../../vendor/easyschematic/src/cloudCache";

export async function listSchematics(): Promise<CachedSchematic[]> {
  return [];
}

export async function loadSchematic(_id: string): Promise<unknown> {
  throw new Error("EasySchematic cloud schematics are not used in the Brink app");
}

export async function refreshCloudCache(): Promise<void> {}
