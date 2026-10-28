// /design: the Brink design system's kitchen sink, for review. Every token and core
// component, live, in the current theme (toggle it in the header). Invented sample data.
import { useEffect, useState, type ReactNode } from "react";
import shieldNavy from "../../public/brand/brink-design-shield-navy.svg";
import shieldWhite from "../../public/brand/brink-design-shield-white.svg";
import { Page } from "../components/ui.js";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  Field,
  IconButton,
  Input,
  Logo,
  Menu,
  Panel,
  PropertyList,
  Select,
  SidePanel,
  Status,
  TabList,
  TabPanel,
  Tag,
  Toolbar,
  ToolbarDivider,
  ToolbarGroup,
  toast,
  useThemeMode,
} from "../design/index.js";

const BRAND: [string, string, string][] = [
  ["--bk-brand-navy", "Brink Navy", "Brand colour, logo ink, dark grounds"],
  ["--bk-brand-navy-700", "Navy 700", "Large supporting fields beside navy"],
  ["--bk-brand-blue", "Brink Blue", "The one accent (proposed in the guide)"],
  ["--bk-brand-white", "White", "The default ground"],
  ["--bk-brand-surface-raised", "Surface Raised", "Cards, table headers"],
  ["--bk-brand-line", "Line", "Hairline rules"],
  ["--bk-brand-border-strong", "Border Strong", "Input outlines"],
  ["--bk-brand-ink-muted", "Ink Muted", "Captions, metadata"],
];

const COLORS: [string, string][] = [
  ["--bk-canvas", "App background"],
  ["--bk-surface", "Surface"],
  ["--bk-surface-2", "Surface 2"],
  ["--bk-hover", "Hover"],
  ["--bk-pressed", "Pressed"],
  ["--bk-line", "Line"],
  ["--bk-line-strong", "Line strong"],
  ["--bk-ink", "Ink"],
  ["--bk-ink-2", "Ink 2"],
  ["--bk-ink-3", "Ink 3"],
  ["--bk-primary", "Primary"],
  ["--bk-accent", "Accent"],
  ["--bk-accent-hover", "Accent hover"],
  ["--bk-accent-soft", "Accent soft"],
  ["--bk-accent-fill", "Accent fill"],
  ["--bk-ok", "OK"],
  ["--bk-warn", "Warning"],
  ["--bk-danger", "Danger"],
  ["--bk-flash", "Live change"],
  ["--bk-paper", "Schematic paper"],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Panel title={title}>
      <div className="p-4">{children}</div>
    </Panel>
  );
}

function useTokenValues(names: string[]) {
  const { dark } = useThemeMode();
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    setValues(Object.fromEntries(names.map((v) => [v, cs.getPropertyValue(v).trim()])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark]);
  return values;
}

function Swatches() {
  const values = useTokenValues(COLORS.map(([v]) => v));
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 p-0" data-swatches>
      {COLORS.map(([v, name]) => (
        <li key={v} className="overflow-hidden rounded-panel border border-line">
          <div className="h-12" style={{ background: `var(${v})` }} />
          <div className="px-2.5 py-1.5">
            <div className="text-xs font-medium">{name}</div>
            <div className="font-num text-2xs text-ink-3">
              {v} {values[v]}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function BrandPalette() {
  return (
    <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 p-0" data-brand-palette>
      {BRAND.map(([v, name, use]) => (
        <li key={v} className="overflow-hidden rounded-panel border border-line">
          <div className="h-12" style={{ background: `var(${v})` }} />
          <div className="px-2.5 py-1.5">
            <div className="text-xs font-medium">{name}</div>
            <div className="font-num text-2xs text-ink-3">{getComputedStyle(document.documentElement).getPropertyValue(v).trim().toUpperCase()}</div>
            <div className="text-2xs text-ink-3">{use}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function DesignPage() {
  const [tab, setTab] = useState<"one" | "two" | "three">("one");
  const [dialog, setDialog] = useState(false);
  const [grid, setGrid] = useState(true);
  useEffect(() => {
    document.title = "Design system · Brink Design";
  }, []);
  return (
    <Page title="Design system" meta="Tokens: dashboard/web/src/design/tokens.css · Docs: dashboard/docs/design-system.md · Sample data is invented." wide>
      <div className="grid gap-x-4 lg:grid-cols-2" data-kitchen-sink>
        <div className="lg:col-span-2">
          <Section title="Brand palette (Brand Guidelines v1.0)">
            <BrandPalette />
            <p className="mt-3 mb-0 text-xs text-ink-3">White grounds and navy type carry the app, the header is a Brink Navy field, and Brink Blue stays a small highlight. No warm, cream or tan grounds; no Brink Productions amber.</p>
          </Section>
          <Section title="Colour tokens (this theme)">
            <Swatches />
          </Section>
        </div>
        <Section title="Logo">
          <div className="grid gap-2.5 sm:grid-cols-2" data-logo-specimens>
            <div className="flex items-center justify-center rounded-panel border border-line bg-[var(--bk-brand-white)] p-4">
              <Logo variant="wordmark" width={128} tone="navy" />
            </div>
            <div className="flex items-center justify-center rounded-panel bg-[var(--bk-brand-navy)] p-4">
              <Logo variant="wordmark" width={128} tone="white" />
            </div>
          </div>
          <p className="mt-3 mb-0 text-xs text-ink-3">
            The wordmark, navy on white and white on Brink Navy, with its clear space. The app header uses it at 72 px (minimum 64 px). The shield is the primary logo, but never shares a screen with the wordmark, so in the app it is the app icon only: <a href={shieldNavy}>shield, navy</a> · <a href={shieldWhite}>shield, white</a> (opens the file).
          </p>
        </Section>
        <Section title="Type: Roboto">
          <div className="space-y-2">
            <div className="text-display font-bold">Display 48</div>
            <div className="text-2xl font-bold">Heading 1 · 32 / 40</div>
            <div className="text-xl font-bold">Heading 2 · 24 / 32 · page titles</div>
            <div className="text-lg font-bold">Heading 3 · 18 / 24 · dialog and card titles</div>
            <div className="text-lg font-light">Light 300 · 18 px and up only</div>
            <div className="text-base">Body · 16 / 24 · We design, install and support the low-voltage systems your building runs on.</div>
            <div className="text-sm">Small · 14 / 20 · tables, controls and the app's dense text</div>
            <div className="bk-label text-ink-3">Label · 12 / 16 · Medium caps +0.12 em</div>
            <div className="num font-num text-sm">1,234.50 LF · tabular numerals</div>
          </div>
        </Section>
        <Section title="Radius, elevation, focus">
          <div className="flex flex-wrap gap-3">
            {(["rounded-ctl shadow-sm", "rounded-panel shadow-md", "rounded-dialog shadow-lg"] as const).map((c) => (
              <div key={c} className={`flex h-20 w-28 items-center justify-center border border-line bg-panel text-xs text-ink-3 ${c}`}>
                {c.split(" ")[0]}
              </div>
            ))}
          </div>
          <p className="mt-3 mb-0 text-xs text-ink-3">Focus: press Tab. Every control shows the same 2 px accent ring, keyboard only.</p>
        </Section>
        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon="save">
              Primary
            </Button>
            <Button>Secondary</Button>
            <Button variant="quiet">Quiet</Button>
            <Button variant="danger">Danger</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm" icon="download">
              Small
            </Button>
          </div>
          <div className="mt-3 flex items-center gap-1">
            <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" />
            <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" />
            <IconButton icon="grid" label="Grid" pressed={grid} onClick={() => setGrid((g) => !g)} />
            <IconButton icon="settings" label="Settings" variant="secondary" />
          </div>
        </Section>
        <Section title="Badges and status">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>neutral</Badge>
            <Badge tone="accent">accent</Badge>
            <Badge tone="ok">ok</Badge>
            <Badge tone="warn">warning</Badge>
            <Badge tone="danger">error</Badge>
            <Tag v="confirmed" />
            <Tag v="unmapped" />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Status tone="ok">All changes saved</Status>
            <Status tone="warn" pulse>
              Saving…
            </Status>
            <Status tone="danger">Not saved</Status>
            <Status>Offline</Status>
          </div>
        </Section>
        <div className="lg:col-span-2">
          <Section title="Toolbar and menu">
            <div className="overflow-hidden rounded-panel border border-line">
              <Toolbar label="Sample toolbar" end={<Menu label="Project" icon="report" align="end" items={[{ type: "heading", label: "Reports" }, { label: "Pack list", onSelect: () => toast("Pack list (sample)") }, { label: "Cable schedule", onSelect: () => toast("Cable schedule (sample)") }, { type: "separator" }, { label: "Export PDF", icon: "download", shortcut: "", onSelect: () => toast("Export (sample)") }]} />}>
                <ToolbarGroup label="History">
                  <IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" />
                  <IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" />
                </ToolbarGroup>
                <ToolbarDivider />
                <Menu label="Insert" icon="plus" items={[{ label: "Room", icon: "room", onSelect: () => undefined }, { label: "Note", icon: "note", onSelect: () => undefined }, { label: "Disabled", disabled: true, onSelect: () => undefined }]} />
                <Menu label="View" icon="eye" items={[{ label: "Minimap", checked: true, onSelect: () => undefined }, { label: "Print view", checked: false, shortcut: "F9", onSelect: () => undefined }]} />
              </Toolbar>
              <div className="flex h-56">
                <SidePanel title="Library" side="left" width={200}>
                  <div className="p-3 text-xs text-ink-3">Side panel content</div>
                </SidePanel>
                <div className="flex-1 bg-[var(--bk-paper)]" />
                <SidePanel title="Inspector" side="right" width={220} onClose={() => undefined}>
                  <div className="p-3">
                    <PropertyList rows={[["Name", "Reception desk"], ["Type", "Data outlet"], ["Room", "Lobby 101"]]} />
                  </div>
                </SidePanel>
              </div>
            </div>
          </Section>
        </div>
        <Section title="Tabs">
          <TabList
            idBase="ks"
            label="Sample tabs"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: "one", label: "Inspector", icon: "inspector" },
              { key: "two", label: "Layers", icon: "layers" },
              { key: "three", label: "Rows", icon: "list", badge: <Badge>12</Badge> },
            ]}
          />
          <TabPanel idBase="ks" k={tab} className="border-t border-line pt-3 text-sm text-ink-2">
            Panel for “{tab}”. Arrow keys move between tabs.
          </TabPanel>
        </Section>
        <Section title="Inputs">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Device name" hint="Saved to the edit layer.">
              {(p) => <Input {...p} placeholder="e.g. Reception desk" />}
            </Field>
            <Field label="Room">
              {(p) => (
                <Select {...p} defaultValue="lobby">
                  <option value="lobby">Lobby 101</option>
                  <option value="office">Office 102</option>
                </Select>
              )}
            </Field>
            <Field label="Cable length (ft)" error="Must be a number.">
              {(p) => <Input {...p} defaultValue="abc" />}
            </Field>
          </div>
        </Section>
        <Section title="Dialog and toast">
          <div className="flex gap-2">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <Button onClick={() => toast("Saved 2 changes (sample).", "ok")}>Show toast</Button>
            <Button onClick={() => toast("Not saved: conflict (sample).", "warn")}>Warning toast</Button>
          </div>
          <Dialog
            open={dialog}
            title="Sample dialog"
            description="Focus is trapped; Escape closes."
            onClose={() => setDialog(false)}
            footer={
              <>
                <Button onClick={() => setDialog(false)}>Cancel</Button>
                <Button variant="primary" onClick={() => setDialog(false)}>
                  Apply
                </Button>
              </>
            }
          >
            <Field label="Title">{(p) => <Input {...p} data-autofocus defaultValue="Level 1 telecom" />}</Field>
          </Dialog>
        </Section>
        <div className="lg:col-span-2">
          <Panel title="Table" count="3 rows">
            <DataTable
              columns={[{ label: "#", numeric: true }, { label: "Kind" }, { label: "Description" }, { label: "Qty", numeric: true }, { label: "Order LF", numeric: true }, { label: "Mapping" }]}
              empty="No rows."
              rows={[
                [1, "device", "Data outlet, 2-port (invented)", "24", "", "confirmed"],
                [2, "cable", "Cat 6 plenum (invented)", "48", "6,240", "proposed"],
                [3, "device", "Wireless access point (invented)", "6", "", "unmapped"],
              ].map((r) => (
                <tr key={String(r[0])} className={r[0] === 2 ? "flash" : undefined}>
                  <td className="num">{r[0]}</td>
                  <td className="code">{r[1]}</td>
                  <td className="desc">{r[2]}</td>
                  <td className="num">{r[3]}</td>
                  <td className="num">{r[4]}</td>
                  <td>
                    <Tag v={r[5]} />
                  </td>
                </tr>
              ))}
            />
          </Panel>
        </div>
      </div>
    </Page>
  );
}
