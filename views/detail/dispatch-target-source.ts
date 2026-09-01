/**
 * How a resolved dispatch target reads in the rail.
 *
 * The precedence itself lives in shared/dispatch-target.ts, which both the
 * dispatch and this view resolve through; all that is left here is putting
 * the winning scope into words.
 */

import type { DispatchTargetResolution } from "../../shared/dispatch-target.js";

/** Short attribution shown beside the target, naming the scope that set it. */
export function describeDispatchTargetOrigin(
  resolution: DispatchTargetResolution,
): string | null {
  switch (resolution.scope) {
    case "task":
      return "from this task";
    case "ancestor":
      return `from ${resolution.ancestorKey}`;
    case "project":
      return "from the project";
    case "none":
      return null;
  }
}
