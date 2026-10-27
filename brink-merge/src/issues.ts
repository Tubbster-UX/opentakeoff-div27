// Fail loud, never silently drop: every problem the pipeline meets becomes an
// Issue that rides the BOM, the schematic's note and the database. `error`
// means the numbers cannot be trusted or an item has nowhere to go (the CLI
// exits nonzero); `warning` is something OpenTakeoff itself discloses and
// excludes or flags (unlinked, held, over length, pending review).

export type Severity = "error" | "warning";

export type IssueCode =
  | "schema_mismatch"
  | "report_mismatch"
  | "report_missing"
  | "unmapped_condition"
  | "mapping_kind_mismatch"
  | "invalid_device_type"
  | "invalid_signal_type"
  | "invalid_connector_type"
  | "mapping_unconfirmed"
  | "cable_type_mismatch"
  | "route_lf_mismatch"
  | "run_not_linked"
  | "unlinked_device"
  | "unlinked_route"
  | "held_device"
  | "over_length"
  | "review_pending"
  | "ot_warning"
  | "schematic_invalid"
  // The schematic edit layer (edits.ts): a person's edit that this import cannot carry.
  | "schematic_edit_orphaned"
  | "schematic_edit_conflict";

export interface Issue {
  severity: Severity;
  code: IssueCode;
  message: string;
  conditionKey?: string;
  refs?: Record<string, unknown>;
}

export class Issues {
  readonly list: Issue[] = [];
  add(severity: Severity, code: IssueCode, message: string, extra: Omit<Issue, "severity" | "code" | "message"> = {}): void {
    this.list.push({ severity, code, message, ...extra });
  }
  error(code: IssueCode, message: string, extra?: Omit<Issue, "severity" | "code" | "message">): void {
    this.add("error", code, message, extra);
  }
  warn(code: IssueCode, message: string, extra?: Omit<Issue, "severity" | "code" | "message">): void {
    this.add("warning", code, message, extra);
  }
  get errors(): Issue[] {
    return this.list.filter((i) => i.severity === "error");
  }
}
