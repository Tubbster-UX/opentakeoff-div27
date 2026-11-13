// Ambient declarations EasySchematic's source expects, as upstream's src/globals.d.ts declares them,
// minus its vite-plugin-pwa reference (the Brink app has no service worker: overrides/sw-register.ts).
// The values are defined in vite.config.ts.
declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
}

interface Window {
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

// Upstream generates src/deviceLibrary.fallback.json at build time; the Brink build serves the same list as a
// module (vite.config.ts), so there is no file for the type checker to read.
declare module "*/deviceLibrary.fallback.json" {
  const templates: import("../../../vendor/easyschematic/src/types").DeviceTemplate[];
  export default templates;
}

// Upstream's sw-register.ts imports this vite-plugin-pwa module. The build replaces sw-register.ts
// (overrides/sw-register.ts), but the type checker still reads the vendored file.
declare module "virtual:pwa-register" {
  export function registerSW(options?: {
    onRegisteredSW?: (url: string, reg: ServiceWorkerRegistration | undefined) => void;
    onNeedRefresh?: () => void;
  }): (reload?: boolean) => Promise<void>;
}
