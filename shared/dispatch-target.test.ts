import { describe, expect, it } from "vitest";
import {
  resolveDispatchTarget,
  type DispatchTargetResolution,
  type DispatchTargetTask,
} from "./dispatch-target";

function task(
  id: string,
  dispatchBbProjectId: string | null,
  parentTaskId: string | null = null,
): DispatchTargetTask {
  return { id, key: id.toUpperCase(), dispatchBbProjectId, parentTaskId };
}

function resolve(
  tasks: readonly DispatchTargetTask[],
  project: string | null,
): Promise<DispatchTargetResolution> {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  return resolveDispatchTarget({
    task: tasks[0]!,
    project: { linkedBbProjectId: project },
    getTask: (taskId) => byId.get(taskId),
  });
}

describe("dispatch target resolution", () => {
  it("prefers the task's own target over its ancestor and project", async () => {
    expect(
      await resolve(
        [task("t", "proj_task", "p"), task("p", "proj_ancestor")],
        "proj_project",
      ),
    ).toEqual({
      bbProjectId: "proj_task",
      scope: "task",
      ancestorKey: null,
    });
  });

  it("falls back to the nearest ancestor that names a target", async () => {
    expect(
      await resolve(
        [task("t", null, "p"), task("p", "proj_ancestor")],
        "proj_project",
      ),
    ).toEqual({
      bbProjectId: "proj_ancestor",
      scope: "ancestor",
      ancestorKey: "P",
    });
  });

  it("falls back to the project when no task in the ancestry names one", async () => {
    expect(
      await resolve([task("t", null, "p"), task("p", null)], "proj_project"),
    ).toEqual({
      bbProjectId: "proj_project",
      scope: "project",
      ancestorKey: null,
    });
  });

  it("stops at a parent cycle and answers from the project", async () => {
    expect(
      await resolve(
        [task("a", null, "b"), task("b", null, "a")],
        "proj_project",
      ),
    ).toEqual({
      bbProjectId: "proj_project",
      scope: "project",
      ancestorKey: null,
    });
  });

  it("resolves to no target when nothing names one", async () => {
    expect(await resolve([task("t", null)], null)).toEqual({
      bbProjectId: null,
      scope: "none",
      ancestorKey: null,
    });
  });

  it("awaits an ancestor lookup that answers asynchronously", async () => {
    const parent = task("p", "proj_ancestor");
    expect(
      await resolveDispatchTarget({
        task: task("t", null, "p"),
        project: { linkedBbProjectId: null },
        getTask: async (taskId) => (taskId === "p" ? parent : null),
      }),
    ).toEqual({
      bbProjectId: "proj_ancestor",
      scope: "ancestor",
      ancestorKey: "P",
    });
  });
});
