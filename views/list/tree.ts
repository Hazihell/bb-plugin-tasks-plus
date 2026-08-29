import type { Task } from "../../shared/contract.js";
import type { TaskSort } from "../../shared/pagination.js";
import { sortTasks } from "../../shared/sort.js";

/**
 * The list's two-level shape: the rows it renders, and the subtasks each of
 * those rows owns. Subtasks are exactly one level deep (the API rejects a
 * parent that itself has a parent), so this is a partition, not a tree walk.
 */
export interface TaskTree {
  /** Rows the list renders as top-level entries, in sort order. */
  parents: Task[];
  /** Subtasks keyed by parent id, sorted with the same sort as the parents. */
  childrenByParent: ReadonlyMap<string, Task[]>;
}

/**
 * Splits a flat task list into parents and their subtasks.
 *
 * `keepParent` is the active filter, and it is applied to parents *only*: a
 * matching parent brings every one of its subtasks whatever their own status,
 * priority, or labels. The converse also holds — a subtask never appears
 * without its parent, so children of a filtered-out (or simply absent) parent
 * are dropped rather than promoted to top-level rows.
 */
export function partitionTasks(
  tasks: readonly Task[],
  sort: TaskSort,
  keepParent: (task: Task) => boolean,
): TaskTree {
  const parents = sortTasks(
    tasks.filter((task) => task.parentTaskId === null && keepParent(task)),
    sort,
  );
  const kept = new Set(parents.map((task) => task.id));
  const childrenByParent = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentTaskId === null || !kept.has(task.parentTaskId)) continue;
    const bucket = childrenByParent.get(task.parentTaskId);
    if (bucket) bucket.push(task);
    else childrenByParent.set(task.parentTaskId, [task]);
  }
  for (const [parentId, children] of childrenByParent) {
    childrenByParent.set(parentId, sortTasks(children, sort));
  }
  return { parents, childrenByParent };
}
