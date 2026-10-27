// Entry of the EasySchematic editor frame (es-frame.html?project=<id>), which
// the Schematic tab embeds. Order matters: the frame's storage is installed
// before any EasySchematic module evaluates (they read localStorage at load),
// so the editor itself is imported dynamically afterwards.
import { installFrameStorage } from "./storage";

installFrameStorage();

const { start } = await import("./mount");
await start();
