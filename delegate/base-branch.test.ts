import { describe, expect, it } from "vitest";
import { resolveBaseBranch, type BaseBranchTask } from "./base-branch";

function task(
  id: string,
  baseBranch: string | null,
  parentTaskId: string | null = null,
): BaseBranchTask {
  return { id, baseBranch, parentTaskId };
}

function resolve(
  tasks: readonly BaseBranchTask[],
  scopes: { project: string | null; preset: string | null },
): string | null {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  return resolveBaseBranch({
    task: tasks[0]!,
    project: { baseBranch: scopes.project },
    preset: { baseBranch: scopes.preset },
    getTask: (taskId) => byId.get(taskId),
  });
}

describe("base branch resolution", () => {
  it("prefers the task's own branch over every broader scope", () => {
    expect(
      resolve([task("t", "task-branch", "p"), task("p", "parent-branch")], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toBe("task-branch");
  });

  it("falls back to the nearest ancestor that names a branch", () => {
    expect(
      resolve([task("t", null, "p"), task("p", "parent-branch")], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toBe("parent-branch");
  });

  it("inherits down a deep sub-task chain, nearest ancestor first", () => {
    const chain = [
      task("t4", null, "t3"),
      task("t3", null, "t2"),
      task("t2", "mid-branch", "t1"),
      task("t1", "root-branch"),
    ];
    expect(resolve(chain, { project: "project-branch", preset: null })).toBe(
      "mid-branch",
    );
  });

  it("falls back to the project when no task in the ancestry names one", () => {
    expect(
      resolve([task("t", null, "p"), task("p", null)], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toBe("project-branch");
  });

  it("falls back to the preset when neither task nor project names one", () => {
    expect(
      resolve([task("t", null)], { project: null, preset: "preset-branch" }),
    ).toBe("preset-branch");
  });

  it("resolves to null — the bb default — when nothing names a branch", () => {
    expect(resolve([task("t", null)], { project: null, preset: null })).toBe(
      null,
    );
  });

  it("stops at a parent cycle and answers from the broader scopes", () => {
    expect(
      resolve([task("a", null, "b"), task("b", null, "a")], {
        project: "project-branch",
        preset: "preset-branch",
      }),
    ).toBe("project-branch");
  });

  it("stops at a self-parent cycle", () => {
    expect(
      resolve([task("a", null, "a")], { project: null, preset: null }),
    ).toBe(null);
  });

  it("ignores an ancestor that no longer exists", () => {
    expect(
      resolve([task("t", null, "gone")], {
        project: null,
        preset: "preset-branch",
      }),
    ).toBe("preset-branch");
  });
});
