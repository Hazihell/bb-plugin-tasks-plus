/**
 * Where a dispatch's base branch comes from, for display only.
 *
 * This mirrors the dispatch-side resolver's order — the task, then its nearest
 * ancestor that names one, then the project, then the preset — over the shapes
 * the rail already has. The resolver itself stays server-side; this names the
 * winning scope so the rail can say more than the branch.
 */

export type BaseBranchOrigin =
  | "task"
  | "ancestor"
  | "project"
  | "preset"
  | "default";

export interface BaseBranchReadout {
  /** The branch a dispatch would use; null means bb picks its default. */
  branch: string | null;
  origin: BaseBranchOrigin;
  /** Key of the ancestor that supplied it, when the origin is an ancestor. */
  ancestorKey: string | null;
}

export interface BaseBranchScopes {
  task: { baseBranch: string | null };
  /** Ancestors nearest first; a partial chain simply resolves further out. */
  ancestors: readonly { key: string; baseBranch: string | null }[];
  project: { baseBranch: string | null } | undefined;
  preset: { name: string; baseBranch: string | null } | undefined;
}

export function readBaseBranch(scopes: BaseBranchScopes): BaseBranchReadout {
  if (scopes.task.baseBranch !== null) {
    return {
      branch: scopes.task.baseBranch,
      origin: "task",
      ancestorKey: null,
    };
  }
  const ancestor = scopes.ancestors.find((entry) => entry.baseBranch !== null);
  if (ancestor) {
    return {
      branch: ancestor.baseBranch,
      origin: "ancestor",
      ancestorKey: ancestor.key,
    };
  }
  if (scopes.project?.baseBranch != null) {
    return {
      branch: scopes.project.baseBranch,
      origin: "project",
      ancestorKey: null,
    };
  }
  if (scopes.preset?.baseBranch != null) {
    return {
      branch: scopes.preset.baseBranch,
      origin: "preset",
      ancestorKey: null,
    };
  }
  return { branch: null, origin: "default", ancestorKey: null };
}

/** Short attribution shown beside an inherited branch. */
export function describeBaseBranchOrigin(
  readout: BaseBranchReadout,
  presetName: string | undefined,
): string | null {
  switch (readout.origin) {
    case "task":
      return null;
    case "ancestor":
      return `from ${readout.ancestorKey}`;
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
