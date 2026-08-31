import { describe, expect, it } from "vitest";
import {
  resolveBaseBranch,
  type BaseBranchResolution,
  type BaseBranchTask,
} from "./base-branch";

function task(
  id: string,
  baseBranch: string | null,
  parentTaskId: string | null = null,
): BaseBranchTask {
  return { id, key: id.toUpperCase(), baseBranch, parentTaskId };
}

function resolve(
  tasks: readonly BaseBranchTask[],
  scopes: { project: string | null; preset: string | null },
): Promise<BaseBranchResolution> {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  return resolveBaseBranch({
    task: tasks[0]!,
    project: { baseBranch: scopes.project },
    preset: { baseBranch: scopes.preset },
    getTask: (taskId) => byId.get(taskId),
  });
}

describe("base branch resolution", () => {
  it("prefers the task's own branch over every broader scope", async () => {
    expect(
      await resolve([task("t", "task-branch", "p"), task("p", "parent-branch")], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toEqual({ branch: "task-branch", scope: "task", ancestorKey: null });
  });

  it("falls back to the nearest ancestor that names a branch", async () => {
    expect(
      await resolve([task("t", null, "p"), task("p", "parent-branch")], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toEqual({
      branch: "parent-branch",
      scope: "ancestor",
      ancestorKey: "P",
    });
  });

  it("inherits down a deep sub-task chain, nearest ancestor first", async () => {
    const chain = [
      task("t4", null, "t3"),
      task("t3", null, "t2"),
      task("t2", "mid-branch", "t1"),
      task("t1", "root-branch"),
    ];
    expect(
      await resolve(chain, { project: "project-branch", preset: null }),
    ).toEqual({ branch: "mid-branch", scope: "ancestor", ancestorKey: "T2" });
  });

  it("falls back to the project when no task in the ancestry names one", async () => {
    expect(
      await resolve([task("t", null, "p"), task("p", null)], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toEqual({
      branch: "project-branch",
      scope: "project",
      ancestorKey: null,
    });
  });

  it("falls back to the preset when neither task nor project names one", async () => {
    expect(
      await resolve([task("t", null)], {
        project: null,
        preset: "preset-branch",
      }),
    ).toEqual({ branch: "preset-branch", scope: "preset", ancestorKey: null });
  });

  it("resolves to null — the bb default — when nothing names a branch", async () => {
    expect(
      await resolve([task("t", null)], { project: null, preset: null }),
    ).toEqual({ branch: null, scope: "default", ancestorKey: null });
  });

  it("stops at a parent cycle and answers from the broader scopes", async () => {
    expect(
      await resolve([task("a", null, "b"), task("b", null, "a")], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toEqual({
      branch: "project-branch",
      scope: "project",
      ancestorKey: null,
    });
  });

  it("stops at a self-parent cycle", async () => {
    expect(
      await resolve([task("a", null, "a")], { project: null, preset: null }),
    ).toEqual({ branch: null, scope: "default", ancestorKey: null });
  });

  it("ignores an ancestor that no longer exists", async () => {
    expect(
      await resolve([task("t", null, "gone")], {
        project: null,
        preset: "preset-branch",
      }),
    ).toEqual({ branch: "preset-branch", scope: "preset", ancestorKey: null });
  });

  it("awaits an ancestor lookup that answers asynchronously", async () => {
    const parent = task("p", "parent-branch");
    expect(
      await resolveBaseBranch({
        task: task("t", null, "p"),
        project: undefined,
        preset: undefined,
        getTask: async (taskId) => (taskId === "p" ? parent : null),
      }),
    ).toEqual({
      branch: "parent-branch",
      scope: "ancestor",
      ancestorKey: "P",
    });
  });
});
