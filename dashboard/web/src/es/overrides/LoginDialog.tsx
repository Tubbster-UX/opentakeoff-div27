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
    <div className="bk fixed inset-0 z-50 flex items-center justify-center bg-[var(--bk-scrim)]" onClick={onClose}>
      <div
        className="w-[360px] rounded-dialog border border-line bg-panel p-5 text-sm text-ink shadow-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Not available in the Brink app"
      >
        <p className="m-0 mb-3">We don&apos;t use EasySchematic accounts, cloud saves or community submissions here. Your changes save to the project in our database as you work.</p>
        <button type="button" className="bk-focus cursor-pointer rounded-ctl border border-line-strong bg-panel px-3 py-1.5 text-ink hover:bg-hover" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
