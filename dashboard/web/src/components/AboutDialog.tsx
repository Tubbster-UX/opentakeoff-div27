// About & licenses: the AGPL notices the app must carry, in the Brink UI.
// EasySchematic's own About dialog is not shown; its license and attribution are here.
import { Badge } from "../design/index.js";

/** The commit of the vendored EasySchematic (vite.config.ts defines it from vendor/easyschematic.lock.json). */
declare const __BUILD_HASH__: string;
declare const __APP_VERSION__: string;

const ES_COMMIT = typeof __BUILD_HASH__ === "string" ? __BUILD_HASH__ : "";
const ES_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

/** Placeholder: the owner sets where the Corresponding Source is offered before anyone outside Brink uses the app. */
const SOURCE_OFFER = "SOURCE-OFFER-URL-TO-BE-SET-BY-OWNER";

export function AboutDialog() {
  return (
    <div className="space-y-4 [&_p]:m-0" data-about>
      <p>
        Our internal project app at <strong>Brink Design</strong>: plan takeoff, schematic and bill of materials for each project. It is free software under the{" "}
        <strong>GNU Affero General Public License v3.0</strong> (AGPL-3.0-only), the license of the repository it is built from.
      </p>
      <section className="rounded-panel border border-line">
        <h3 className="bk-label m-0 border-b border-line px-3 py-2 text-ink-3">Includes</h3>
        <ul className="m-0 list-none divide-y divide-line p-0">
          <li className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">EasySchematic</span>
              <Badge>AGPL-3.0</Badge>
              <span className="num text-xs text-ink-3">
                {ES_VERSION} · commit {ES_COMMIT}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-2">
              The schematic editor engine (store, routing, reports, file format) by duremovich:{" "}
              <a href="https://github.com/duremovich/EasySchematic">github.com/duremovich/EasySchematic</a>. Vendored in <span className="font-num">dashboard/vendor/easyschematic</span>{" "}
              with its LICENSE; the Brink UI around it and every change are listed in <span className="font-num">dashboard/vendor/PATCHES.md</span>.
            </p>
          </li>
          <li className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">OpenTakeoff</span>
              <Badge>AGPL-3.0</Badge>
            </div>
            <p className="mt-1 text-xs text-ink-2">
              The takeoff engine and protocol this repository is a fork of: <a href="https://github.com/Kentucky-ai/opentakeoff">github.com/Kentucky-ai/opentakeoff</a>.
            </p>
          </li>
          <li className="px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">React, React Flow (@xyflow/react), zustand, react-router, jsPDF, html-to-image</span>
              <Badge>MIT</Badge>
            </div>
          </li>
        </ul>
      </section>
      <section>
        <h3 className="bk-label m-0 mb-1 text-ink-3">Source code</h3>
        <p className="text-xs text-ink-2">
          Under the AGPL, everyone who uses this app over a network may get its complete source code. Source offer: <span className="font-num" data-source-offer>{SOURCE_OFFER}</span>
        </p>
      </section>
    </div>
  );
}
