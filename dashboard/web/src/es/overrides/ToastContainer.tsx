// Replaces EasySchematic's src/components/ToastContainer.tsx. Upstream renders its
// store's toasts in its own style; here each one is handed to the app's toasts
// (design/components/Toast.tsx), so the whole app has one notification look and place.
// The store's toast actions are untouched: addToast still adds, and the toast is
// removed from the store once it is shown.
import { useEffect } from "react";
import { useSchematicStore } from "../../../../vendor/easyschematic/src/store";
import { toast, type ToastTone } from "../../design/components/Toast.js";

const TONE: Record<"error" | "success" | "info", ToastTone> = { error: "danger", success: "ok", info: "info" };

export default function ToastContainer() {
  const toasts = useSchematicStore((s) => s.toasts);
  const removeToast = useSchematicStore((s) => s.removeToast);
  useEffect(() => {
    for (const t of toasts) {
      toast(t.message, TONE[t.type] ?? "info", t.type === "error" ? 8000 : 4000);
      removeToast(t.id);
    }
  }, [toasts, removeToast]);
  return null;
}
