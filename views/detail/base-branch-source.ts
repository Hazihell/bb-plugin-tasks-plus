/**
 * How a resolved base branch reads in the rail.
 *
 * The precedence itself lives in shared/base-branch.ts, which both the
 * dispatch and this view resolve through; all that is left here is putting
 * the winning scope into words.
 */

import type { BaseBranchResolution } from "../../shared/base-branch.js";

/** Short attribution shown beside the branch, naming the scope that set it. */
export function describeBaseBranchOrigin(
  resolution: BaseBranchResolution,
  presetName: string | undefined,
): string | null {
  switch (resolution.scope) {
    case "task":
      return "from this task";
    case "ancestor":
      return `from ${resolution.ancestorKey}`;
    case "project":
      return "from the project";
    case "preset":
      return presetName === undefined
        ? "from the preset"
        : `from preset ${presetName}`;
    case "default":
      return null;
  }
}
