// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Task } from "../../shared/contract.js";
import { installBrowserMocks } from "./browser-mocks.js";

installBrowserMocks({ compactViewport: true });

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const project = {
  id: PROJECT_ID,
  name: "Tasks Plugin",
  prefix: "TSK",
  nextTaskNumber: 5,
  color: "blue",
  folderId: null,
  linkedBbProjectId: null,
  createdAt: "2026-07-15T00:00:00.000Z",
};

function task(
  number: number,
  status: Task["status"],
  parentTaskId: string | null = null,
): Task {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZT${number}`,
    projectId: PROJECT_ID,
    number,
    key: `TSK-${number}`,
    title: `Task ${number}`,
    description: "",
    status,
    priority: "none",
    dueDate: null,
    parentTaskId,
    position: number,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    labelIds: [],
  };
}

const parent = task(1, "todo");
// Both children carry a status the parent's group header does not claim.
const doneChild = task(2, "done", parent.id);
const reviewChild = task(3, "in_review", parent.id);
const otherParent = task(4, "done");

const tasks = [parent, doneChild, reviewChild, otherParent];

function renderList(rows: Task[] = tasks) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: PROJECT_ID },
    {
      rpc: {
        listProjects: () => ({ projects: [project] }),
        listFolders: () => ({ folders: [] }),
        listPresets: () => ({ presets: [] }),
        sidebarSummary: () => ({ projects: [] }),
        listLabels: () => ({ labels: [] }),
        listTasks: () => ({ tasks: rows }),
        listTaskThreads: () => ({ taskThreads: [] }),
        listComments: () => ({ comments: [] }),
        listAttachments: () => ({ attachments: [] }),
      },
    },
  );
}

function rowKeys(slot: ReturnType<typeof renderList>): (string | null)[] {
  return Array.from(slot.container.querySelectorAll("[data-task-key]")).map(
    (row) => row.getAttribute("data-task-key"),
  );
}

function queryGroupHeader(
  slot: ReturnType<typeof renderList>,
  status: Task["status"],
): HTMLElement | null {
  return slot.container.querySelector<HTMLElement>(
    `[data-status-group-header="${status}"]`,
  );
}

function getGroupHeader(
  slot: ReturnType<typeof renderList>,
  status: Task["status"],
): HTMLElement {
  const header = queryGroupHeader(slot, status);
  if (header === null) throw new Error(`no ${status} group header`);
  return header;
}

async function expandParent(slot: ReturnType<typeof renderList>) {
  fireEvent.click(
    await slot.findByRole("button", { name: "Expand 2 subtasks of TSK-1" }),
  );
}

describe("subtasks in the list view", () => {
  it("starts collapsed and shows the child count in the parent's rail", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");
    expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-4"]);
    const parentRow = slot.container.querySelector<HTMLElement>(
      '[data-task-key="TSK-1"]',
    )!;
    expect(
      within(parentRow).getByTitle("2 subtasks").textContent,
    ).toContain("2");
    // Only a parent that owns subtasks gets a chevron.
    expect(
      slot.queryByRole("button", { name: /subtasks of TSK-4/ }),
    ).toBeNull();
  });

  it("nests children under their parent's group even when their status differs", async () => {
    const slot = renderList();
    await expandParent(slot);
    await waitFor(() =>
      expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-2", "TSK-3", "TSK-4"]),
    );
    // Group membership follows the parent: the done and in-review children sit
    // inside the Todo section, and no In Review group exists at all.
    const todoSection = getGroupHeader(slot, "todo").parentElement!;
    expect(
      within(todoSection).getByText("TSK-2").closest("[data-task-key]"),
    ).not.toBeNull();
    expect(queryGroupHeader(slot, "in_review")).toBeNull();
    // Header counts stay counts of parents: one Todo, one Done.
    expect(getGroupHeader(slot, "todo").textContent).toContain("1");
    expect(getGroupHeader(slot, "done").textContent).toContain("1");
    expect(slot.getByText("2 tasks")).toBeTruthy();
  });

  it("collapses again from the same chevron", async () => {
    const slot = renderList();
    await expandParent(slot);
    const collapse = await slot.findByRole("button", {
      name: "Collapse 2 subtasks of TSK-1",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    await waitFor(() => expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-4"]));
    expect(
      slot
        .getByRole("button", { name: "Expand 2 subtasks of TSK-1" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("remembers which parents were open, per list surface", async () => {
    const first = renderList();
    await expandParent(first);
    await waitFor(() =>
      expect(rowKeys(first)).toEqual(["TSK-1", "TSK-2", "TSK-3", "TSK-4"]),
    );
    cleanup();

    // A fresh mount of the same surface reads the choice back out of storage.
    const reopened = renderList();
    await waitFor(() =>
      expect(rowKeys(reopened)).toEqual(["TSK-1", "TSK-2", "TSK-3", "TSK-4"]),
    );
    await reopened.findByRole("button", {
      name: "Collapse 2 subtasks of TSK-1",
    });
    cleanup();

    // And says nothing about a different one: All is its own scope.
    const allTasks = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listProjects: () => ({ projects: [project] }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listLabels: () => ({ labels: [] }),
          listTasks: () => ({ tasks }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
          listAttachments: () => ({ attachments: [] }),
        },
      },
    );
    await allTasks.findByRole("button", {
      name: "Expand 2 subtasks of TSK-1",
    });
  });

  it("filters parents only, so a child never renders without its parent", async () => {
    const slot = renderList();
    await expandParent(slot);
    await waitFor(() => expect(rowKeys(slot)).toHaveLength(4));

    fireEvent.click(slot.getByRole("button", { name: /^Status/ }));
    fireEvent.click(
      await slot.findByRole("menuitemcheckbox", { name: /Done/ }),
    );
    // TSK-2 is done, but its parent isn't: it drops out with TSK-1 rather than
    // being promoted into the Done group.
    await waitFor(() => expect(rowKeys(slot)).toEqual(["TSK-4"]));
    expect(slot.getByText("1 task")).toBeTruthy();
  });

  it("keeps a filtered-in parent's children whatever their own status", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");

    fireEvent.click(slot.getByRole("button", { name: /^Status/ }));
    fireEvent.click(
      await slot.findByRole("menuitemcheckbox", { name: /Todo/ }),
    );
    await waitFor(() => expect(rowKeys(slot)).toEqual(["TSK-1"]));

    await expandParent(slot);
    await waitFor(() =>
      expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-2", "TSK-3"]),
    );
  });
});
