// Loads the Takeoff workspace for the app (web/src/ot-workspace.d.ts types it for the
// shell). The OpenTakeoff canvas and pdf.js are a separate chunk, fetched the first
// time the Takeoff tab opens.
export async function loadTakeoffWorkspace() {
  return import("./workspace");
}
