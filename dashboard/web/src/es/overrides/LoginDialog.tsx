// Brink override of EasySchematic's src/components/LoginDialog.tsx
// (vendor/PATCHES.md). There are no EasySchematic accounts in the Brink app;
// where upstream would ask the user to sign in (community submissions), this
// says so instead.
interface Props {
  open: boolean;
  onClose: () => void;
}

export default function LoginDialog({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="bg-white border border-[var(--color-border)] rounded-lg shadow-2xl w-[360px] p-5 text-sm text-[var(--color-text)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Not available in the Brink app"
      >
        <p className="m-0 mb-3">EasySchematic accounts, cloud saves and community submissions are not used in the Brink app. The project&apos;s schematic saves to Brink&apos;s database as you edit.</p>
        <button type="button" className="px-3 py-1.5 rounded bg-[var(--color-surface-hover)] cursor-pointer" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
