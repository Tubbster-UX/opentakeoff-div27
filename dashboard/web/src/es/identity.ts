// The Cloudflare Access identity of the person using the editor frame, for
// the menu bar (overrides/UserMenuButton.tsx). Set once by mount.tsx.
let editor: { email: string; auth: string } | null = null;

export function setEditor(e: { email: string; auth: string } | null): void {
  editor = e;
}

export function getEditor(): { email: string; auth: string } | null {
  return editor;
}
