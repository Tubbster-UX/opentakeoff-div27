// Brink override of EasySchematic's src/components/UserMenuButton.tsx
// (vendor/PATCHES.md). Upstream shows an EasySchematic account (log in / log
// out). In the Brink app the person is the Cloudflare Access identity every
// saved edit is recorded under, so the menu bar shows that instead.
import { getEditor } from "../identity";

export default function UserMenuButton() {
  const editor = getEditor();
  if (!editor) return <span className="px-3 py-1.5 text-xs text-[var(--color-text-muted)]">Read-only: no identity</span>;
  return (
    <span
      className="px-3 py-1.5 text-xs text-[var(--color-text)]"
      data-brink-editor={editor.email}
      title={editor.auth === "dev-bypass" ? "Local development identity (not Cloudflare Access)" : "Signed in through Cloudflare Access; your edits are saved under this email"}
    >
      {editor.email}
      {editor.auth === "dev-bypass" ? " (dev)" : ""}
    </span>
  );
}
