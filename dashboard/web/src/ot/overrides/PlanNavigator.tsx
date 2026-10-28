// Replaces OpenTakeoff's components/PlanNavigator.jsx (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream's plan-set gallery (page previews, side-by-side, match-line stitching, sheet
// levels) is kept: the Brink sheets panel opens sheets, the gallery is still where a person
// stitches and groups them (Panels > Plan set gallery). What this wrapper removes are the
// gallery's entry points to things that are not part of the Brink app: the premium plans
// page, the guided tour on upstream's bundled sample plan, "Connect your AI", and "Clear
// workspace" (which deletes every plan in the browser-only store). Everything else is
// upstream's component with upstream's props.
import type { ComponentProps } from "react";
import PlanNavigator from "../../../../vendor/opentakeoff/src/components/PlanNavigator.jsx";

type Props = ComponentProps<typeof PlanNavigator>;

export default function BrinkPlanNavigator(props: Props) {
  return <PlanNavigator {...props} onPremium={undefined} onStartTour={undefined} onConnect={undefined} onClearWorkspace={undefined} />;
}
