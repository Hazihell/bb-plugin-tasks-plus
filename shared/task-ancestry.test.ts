import { describe, expect, it } from "vitest";
import { walkTaskAncestry, type TaskAncestryNode } from "./task-ancestry";

interface TestTask extends TaskAncestryNode {
  value: string | null;
}

function task(
  id: string,
  value: string | null,
  parentTaskId: string | null = null,
): TestTask {
  return { id, key: id.toUpperCase(), value, parentTaskId };
}

describe("task ancestry walker", () => {
  it("returns the nearest matching task and whether it was the starting task", async () => {
    const child = task("child", null, "parent");
    const parent = task("parent", "from-parent");
    const byId = new Map([child, parent].map((entry) => [entry.id, entry]));

    await expect(
      walkTaskAncestry(
        child,
        (taskId) => byId.get(taskId),
        (entry) => entry.value,
      ),
    ).resolves.toEqual({ task: parent, value: "from-parent", isSelf: false });

    await expect(
      walkTaskAncestry(child, () => null, (entry) => entry.value),
    ).resolves.toEqual(null);

    await expect(
      walkTaskAncestry(task("own", "from-task"), () => null, (entry) => entry.value),
    ).resolves.toEqual({
      task: task("own", "from-task"),
      value: "from-task",
      isSelf: true,
    });
  });

  it("stops before revisiting a parent cycle", async () => {
    const first = task("first", null, "second");
    const second = task("second", null, "first");
    const byId = new Map([first, second].map((entry) => [entry.id, entry]));
    const lookups: string[] = [];

    await expect(
      walkTaskAncestry(
        first,
        (taskId) => {
          lookups.push(taskId);
          return byId.get(taskId);
        },
        (entry) => entry.value,
      ),
    ).resolves.toBeNull();
    expect(lookups).toEqual(["second", "first"]);
  });
});
