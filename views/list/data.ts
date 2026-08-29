import { listAllTasks, useTasksQuery } from "../../shell/data.js";
import type { Label, Task, TaskThread } from "../../shared/contract.js";

/**
 * Every task in scope — parents and subtasks together in one flat array, so
 * the list can nest a subtask under its parent without a second query.
 * Status/priority/label filtering is deliberately *not* a query param: those
 * filters apply to parents only, and a matching parent must bring all of its
 * children regardless of their own status. The view partitions and filters
 * client-side; only `projectId` and `activeOnly` narrow the fetch, so changing
 * a filter never refetches.
 */
export function useListTasks(projectId: string | null, activeOnly: boolean) {
  return useTasksQuery(
    async (rpc) =>
      listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        activeOnly,
      }),
    ["tasks:changed", "threads:changed"],
    [projectId, activeOnly],
  );
}

/**
 * Labels for one or many projects. The contract only exposes per-project
 * listLabels, so cross-project routes fan out one call per project. (No shell
 * hook exists for labels; implemented locally per worker ownership rules.)
 */
export function useLabels(projectIds: readonly string[]) {
  return useTasksQuery<Label[]>(
    async (rpc) => {
      const results = await Promise.all(
        projectIds.map((projectId) => rpc.call("listLabels", { projectId })),
      );
      return results.flatMap((result) => result.labels);
    },
    ["projects:changed"],
    [projectIds.join()],
  );
}

export interface TaskRowMeta {
  /** Threads currently starting or working. Historical attachments (idle,
   * completed, failed) are excluded — list rows only surface live activity. */
  activeThreads: TaskThread[];
}

/**
 * Live-activity metadata for list rows. Comments and attachments are detail-
 * view concerns and are deliberately not fetched here. The contract has no
 * bulk endpoint, so this fans out per task — fine at current scale; a batched
 * RPC is the follow-up if lists grow large.
 */
export function useTaskListMeta(tasks: readonly Task[] | undefined) {
  const taskIds = (tasks ?? []).map((task) => task.id);
  return useTasksQuery<Map<string, TaskRowMeta>>(
    async (rpc) => {
      const entries = await Promise.all(
        taskIds.map(async (taskId) => {
          const threads = await rpc.call("listTaskThreads", { taskId });
          const meta: TaskRowMeta = {
            activeThreads: threads.taskThreads.filter(
              (thread) =>
                thread.liveStatus === "starting" ||
                thread.liveStatus === "working",
            ),
          };
          return [taskId, meta] as const;
        }),
      );
      return new Map(entries);
    },
    ["threads:changed", "tasks:changed"],
    [taskIds.join()],
  );
}
