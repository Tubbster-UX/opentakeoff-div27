// Brink override of EasySchematic's src/sw-register.ts (vendor/PATCHES.md).
// The Brink app is not a PWA: no service worker is registered (upstream's
// vite-plugin-pwa is not part of the build), so there is never an update to
// apply. The exports keep upstream's signatures for UpdatePill and AboutDialog.

export function initServiceWorkerUpdates(): void {}

export function triggerUpdate(): void {
  location.reload();
}

export async function forceFullReset(): Promise<void> {
  location.reload();
}
