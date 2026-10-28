// Replaces EasySchematic components whose place the Brink UI takes or that do not
// apply inside the Brink app (vendor/PATCHES.md says which, and where each feature went):
//   ShowInfoPanel, SignalColorPanel  -> tabs of the Brink right panel (brink/RightPanel.tsx)
//   UpdatePill                       -> no service worker in the app
//   BetaBanner                       -> only for beta.easyschematic.live
//   MobileGate                       -> the "designed for desktop" overlay; the app's own layout handles phones
export default function Nothing(_props: { mobile?: boolean; onClose?: () => void }) {
  return null;
}
