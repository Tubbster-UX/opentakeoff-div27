// Replaces the import of src/components/DeviceLibrary.tsx inside upstream App: the
// same upstream device library (search, categories, favourites, drag to the canvas,
// owned gear), shown or hidden by the Brink toolbar's Library toggle. Restyled only
// through the token mapping (design/es-theme.css).
import DeviceLibrary from "../../../../vendor/easyschematic/src/components/DeviceLibrary";
import { useSession } from "../session";

export default function LibraryPanel() {
  const { library } = useSession();
  if (!library) return null;
  return (
    <div className="h-full" data-brink-library>
      <DeviceLibrary />
    </div>
  );
}
