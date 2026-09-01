/** The task fields needed to walk from a task toward its ancestors. */
export interface TaskAncestryNode {
  id: string;
  key: string;
  parentTaskId: string | null;
}

export interface TaskAncestryMatch<
  T extends TaskAncestryNode,
  V,
> {
  task: T;
  value: V;
  isSelf: boolean;
}

/**
 * Finds the nearest task for which `pick` returns a non-null value. A repeated
 * id stops the walk before that task is visited again, so malformed cycles do
 * not hang callers.
 */
export async function walkTaskAncestry<
  T extends TaskAncestryNode,
  V,
>(
  task: T,
  getTask: (
    taskId: string,
  ) => T | undefined | null | Promise<T | undefined | null>,
  pick: (task: T) => V | null,
): Promise<TaskAncestryMatch<T, V> | null> {
  const seen = new Set<string>();
  let current: T | undefined | null = task;
  let isSelf = true;
  while (current && !seen.has(current.id)) {
    const value = pick(current);
    if (value !== null) return { task: current, value, isSelf };
    seen.add(current.id);
    isSelf = false;
    current =
      current.parentTaskId === null
        ? undefined
        : await getTask(current.parentTaskId);
  }
  return null;
}
