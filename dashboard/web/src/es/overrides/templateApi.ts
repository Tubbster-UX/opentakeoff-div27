// Brink override of EasySchematic's src/templateApi.ts (vendor/PATCHES.md).
// Upstream's module talks to api.easyschematic.live: accounts, cloud saves,
// share links, community submissions, and the live device library. The Brink
// app uses none of it: the project database is the store of record, identity
// is Cloudflare Access, and the device library is the one bundled with the
// vendored source. Everything else is upstream's own code, re-exported.
import type { DeviceTemplate } from "../../../../vendor/easyschematic/src/types";
import { getBundledTemplates } from "../../../../vendor/easyschematic/src/templateApi";

export * from "../../../../vendor/easyschematic/src/templateApi";

const OFF = "EasySchematic accounts and cloud features are not used in the Brink app; the project saves to Brink's database.";
const off = (): never => {
  throw new Error(OFF);
};

/** No EasySchematic account: every account feature stays in its signed-out state. */
export async function checkSession(): Promise<{ id: string; email: string; name: string | null } | null> {
  return null;
}
export async function requestLogin(_email: string, _returnTo?: string): Promise<void> {
  off();
}
export async function createDraft(_data: unknown): Promise<string> {
  return off();
}
export async function createHandoff(): Promise<string> {
  return off();
}
export async function logout(): Promise<void> {}
export async function saveSchematicToCloud(_data: unknown): Promise<never> {
  return off();
}
export async function updateSchematicInCloud(_id: string, _data: unknown): Promise<never> {
  return off();
}
export async function listCloudSchematics(): Promise<never[]> {
  return [];
}
export async function loadCloudSchematic(_id: string): Promise<unknown> {
  return off();
}
export async function deleteCloudSchematic(_id: string): Promise<void> {
  off();
}
export async function toggleSchematicSharing(_id: string, _shared: boolean): Promise<never> {
  return off();
}
export async function loadSharedSchematic(_token: string): Promise<unknown> {
  return off();
}
export async function renameCloudSchematic(_id: string, _name: string): Promise<never> {
  return off();
}
export async function setSchematicAsTemplate(_id: string): Promise<void> {
  off();
}
export async function clearSchematicTemplate(): Promise<void> {}
/** No saved "new schematic" template: File > New starts empty, as for a signed-out user. */
export async function loadSchematicTemplate(): Promise<unknown | null> {
  return null;
}
export async function createSubmission(..._args: unknown[]): Promise<never> {
  return off();
}
/** The bundled library only (no network fetch, no IndexedDB cache). */
export async function fetchTemplates(): Promise<DeviceTemplate[]> {
  return getBundledTemplates();
}
