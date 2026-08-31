/**
 * Which branch a dispatch's worktree starts from, and which scope decided it.
 *
 * One precedence, read by both sides: the dispatch resolves it to spawn from,
 * the rail resolves it to say where it came from. Narrowest scope first — the
 * task itself, then its nearest ancestor that names one, then the task's
 * project, then the preset. A null branch means "let bb pick its default".
 *
 * The ancestor lookup is a parameter so each caller supplies its own reach:
 * the dispatch a synchronous store read, the rail an RPC call. Either may
 * answer with a promise, so resolution is asynchronous for both.
 */

/** The parts of a task the resolver reads while walking its ancestry. */
export interface BaseBranchTask {
  id: string;
  key: string;
  baseBranch: string | null;
  parentTaskId: string | null;
}

/** The scope that supplied the branch; "default" means nothing named one. */
export type BaseBranchScope =
  | "task"
  | "ancestor"
  | "project"
  | "preset"
  | "default";

export interface BaseBranchResolution {
  /** The branch a dispatch would use; null means bb picks its default. */
  branch: string | null;
  scope: BaseBranchScope;
  /** Key of the ancestor that supplied it, when the scope is an ancestor. */
  ancestorKey: string | null;
}

export interface BaseBranchScopes {
  task: BaseBranchTask;
  project: { baseBranch: string | null } | undefined;
  preset: { baseBranch: string | null } | undefined;
  /** Reads an ancestor task by id; undefined/null when it no longer exists. */
  getTask: (
    taskId: string,
  ) =>
    | BaseBranchTask
    | undefined
    | null
    | Promise<BaseBranchTask | undefined | null>;
}

/**
 * The ancestry walk stops on a repeated id, so a parent cycle written by an
 * older schema (or by direct SQL) degrades to the project/preset answer
 * instead of hanging the caller.
 */
export async function resolveBaseBranch(
  scopes: BaseBranchScopes,
): Promise<BaseBranchResolution> {
  const seen = new Set<string>();
  let current: BaseBranchTask | undefined | null = scopes.task;
  let isSelf = true;
  while (current && !seen.has(current.id)) {
    if (current.baseBranch !== null) {
      return isSelf
        ? { branch: current.baseBranch, scope: "task", ancestorKey: null }
        : {
            branch: current.baseBranch,
            scope: "ancestor",
            ancestorKey: current.key,
          };
    }
    seen.add(current.id);
    isSelf = false;
    current =
      current.parentTaskId === null
        ? undefined
        : await scopes.getTask(current.parentTaskId);
  }
  if (scopes.project?.baseBranch != null) {
    return {
      branch: scopes.project.baseBranch,
      scope: "project",
      ancestorKey: null,
    };
  }
  if (scopes.preset?.baseBranch != null) {
    return {
      branch: scopes.preset.baseBranch,
      scope: "preset",
      ancestorKey: null,
    };
  }
  return { branch: null, scope: "default", ancestorKey: null };
}
