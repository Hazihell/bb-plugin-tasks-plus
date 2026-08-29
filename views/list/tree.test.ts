import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/contract.js";
import { partitionTasks } from "./tree.js";

function task(overrides: Partial<Task> & Pick<Task, "id">): Task {
  return {
    projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    number: 1,
    key: overrides.id,
    title: `Task ${overrides.id}`,
    description: "",
    status: "todo",
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    labelIds: [],
    ...overrides,
  };
}

const keep = () => true;

describe("partitionTasks", () => {
  it("hangs children off their parent whatever their own status", () => {
    const parent = task({ id: "P1", status: "todo" });
    const child = task({ id: "C1", parentTaskId: "P1", status: "done" });
    const tree = partitionTasks([parent, child], "manual", keep);
    expect(tree.parents.map((item) => item.id)).toEqual(["P1"]);
    expect(tree.childrenByParent.get("P1")?.map((item) => item.id)).toEqual([
      "C1",
    ]);
  });

  it("drops a child whose parent is not in the list", () => {
    const orphan = task({ id: "C1", parentTaskId: "MISSING" });
    const tree = partitionTasks([orphan], "manual", keep);
    expect(tree.parents).toEqual([]);
    expect(tree.childrenByParent.size).toBe(0);
  });

  it("applies the filter to parents only, children included or dropped with them", () => {
    const kept = task({ id: "P1", status: "todo" });
    const dropped = task({ id: "P2", status: "done" });
    const keptChild = task({ id: "C1", parentTaskId: "P1", status: "done" });
    const droppedChild = task({ id: "C2", parentTaskId: "P2", status: "todo" });
    const tree = partitionTasks(
      [kept, dropped, keptChild, droppedChild],
      "manual",
      (item) => item.status === "todo",
    );
    // The done child rides in on its todo parent; the todo child of a
    // filtered-out parent is not promoted to a row of its own.
    expect(tree.parents.map((item) => item.id)).toEqual(["P1"]);
    expect(tree.childrenByParent.get("P1")?.map((item) => item.id)).toEqual([
      "C1",
    ]);
    expect(tree.childrenByParent.has("P2")).toBe(false);
  });

  it("sorts children with the same sort as the parents", () => {
    const parents = [
      task({ id: "P1", priority: "low" }),
      task({ id: "P2", priority: "urgent" }),
    ];
    const children = [
      task({ id: "C1", parentTaskId: "P1", priority: "low" }),
      task({ id: "C2", parentTaskId: "P1", priority: "urgent" }),
    ];
    const tree = partitionTasks([...parents, ...children], "priority", keep);
    expect(tree.parents.map((item) => item.id)).toEqual(["P2", "P1"]);
    expect(tree.childrenByParent.get("P1")?.map((item) => item.id)).toEqual([
      "C2",
      "C1",
    ]);
  });
});
