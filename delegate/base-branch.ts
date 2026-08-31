import type { Preset, Project, Task } from "../db";

/** The parts of a task the resolver reads while walking its ancestry. */
export type BaseBranchTask = Pick<Task, "id" | "baseBranch" | "parentTaskId">;

export interface BaseBranchScopes {
  task: BaseBranchTask;
  project: Pick<Project, "baseBranch">;
  preset: Pick<Preset, "baseBranch">;
  /** Reads an ancestor task by id; undefined when it no longer exists. */
  getTask: (taskId: string) => BaseBranchTask | undefined;
}

/**
 * The worktree base branch a dispatch should use, narrowest scope first: the
 * task itself, then its nearest ancestor that names one, then the task's
 * project, then the preset. Null means "let bb pick its default".
 *
 * The ancestry walk stops on a repeated id, so a parent cycle written by an
 * older schema (or by direct SQL) degrades to the project/preset answer
 * instead of hanging the dispatch.
 */
export function resolveBaseBranch(scopes: BaseBranchScopes): string | null {
  const seen = new Set<string>();
  let current: BaseBranchTask | undefined = scopes.task;
  while (current && !seen.has(current.id)) {
    if (current.baseBranch !== null) return current.baseBranch;
    seen.add(current.id);
    current =
      current.parentTaskId === null
        ? undefined
        : scopes.getTask(current.parentTaskId);
  }
  return scopes.project.baseBranch ?? scopes.preset.baseBranch;
}
