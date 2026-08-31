/**
 * Which bb project a dispatch spawns into, and which scope decided it.
 *
 * One precedence, read by both sides: the dispatch resolves it to spawn into,
 * the rail resolves it to say where it came from. Narrowest scope first —
 * the task itself, then its nearest ancestor that names one, then the task's
 * project. A null target means the task has no bb project to spawn into.
 *
 * The ancestor lookup is a parameter so each caller supplies its own reach:
 * the dispatch a synchronous store read, the rail an RPC call. Either may
 * answer with a promise, so resolution is asynchronous for both.
 */

/** The parts of a task the resolver reads while walking its ancestry. */
export interface DispatchTargetTask {
  id: string;
  key: string;
  dispatchBbProjectId: string | null;
  parentTaskId: string | null;
}

/** The scope that supplied the bb project; "none" means no target was named. */
export type DispatchTargetScope = "task" | "ancestor" | "project" | "none";

export interface DispatchTargetResolution {
  /** The bb project a dispatch would use; null means no target is configured. */
  bbProjectId: string | null;
  scope: DispatchTargetScope;
  /** Key of the ancestor that supplied it, when the scope is an ancestor. */
  ancestorKey: string | null;
}

export interface DispatchTargetScopes {
  task: DispatchTargetTask;
  project: { linkedBbProjectId: string | null };
  /** Reads an ancestor task by id; undefined/null when it no longer exists. */
  getTask: (
    taskId: string,
  ) =>
    | DispatchTargetTask
    | undefined
    | null
    | Promise<DispatchTargetTask | undefined | null>;
}

/**
 * The ancestry walk stops on a repeated id, so a parent cycle written by an
 * older schema (or by direct SQL) degrades to the project answer instead of
 * hanging the caller.
 */
export async function resolveDispatchTarget(
  scopes: DispatchTargetScopes,
): Promise<DispatchTargetResolution> {
  const seen = new Set<string>();
  let current: DispatchTargetTask | undefined | null = scopes.task;
  let isSelf = true;
  while (current && !seen.has(current.id)) {
    if (current.dispatchBbProjectId !== null) {
      return isSelf
        ? {
            bbProjectId: current.dispatchBbProjectId,
            scope: "task",
            ancestorKey: null,
          }
        : {
            bbProjectId: current.dispatchBbProjectId,
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
  if (scopes.project.linkedBbProjectId !== null) {
    return {
      bbProjectId: scopes.project.linkedBbProjectId,
      scope: "project",
      ancestorKey: null,
    };
  }
  return { bbProjectId: null, scope: "none", ancestorKey: null };
}
