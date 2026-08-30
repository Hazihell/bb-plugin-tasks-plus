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
  nextTaskNumber: 6,
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
const childA = task(2, "todo", parent.id);
const childB = task(3, "todo", parent.id);
const secondTodo = task(5, "todo");
const doneParent = task(4, "done");

const tasks = [parent, childA, childB, secondTodo, doneParent];

function renderList(subPath: string = PROJECT_ID) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath },
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
}

type Slot = ReturnType<typeof renderList>;

function rowKeys(slot: Slot): (string | null)[] {
  return Array.from(slot.container.querySelectorAll("[data-task-key]")).map(
    (row) => row.getAttribute("data-task-key"),
  );
}

function groupHeader(slot: Slot, status: Task["status"]): HTMLElement {
  const header = slot.container.querySelector<HTMLElement>(
    `[data-status-group-header="${status}"]`,
  );
  if (header === null) throw new Error(`no ${status} group header`);
  return header;
}

async function expandParent(slot: Slot) {
  fireEvent.click(
    await slot.findByRole("button", { name: "Expand 2 subtasks of TSK-1" }),
  );
}

describe("collapsing a status group from its header", () => {
  it("hides the group's rows and restores them on a second click", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");
    expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-5", "TSK-4"]);

    fireEvent.click(groupHeader(slot, "todo"));
    await waitFor(() => expect(rowKeys(slot)).toEqual(["TSK-4"]));

    fireEvent.click(groupHeader(slot, "todo"));
    await waitFor(() =>
      expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-5", "TSK-4"]),
    );
  });

  it("keeps the collapsed group's header, label and parent count", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");
    fireEvent.click(groupHeader(slot, "todo"));

    await waitFor(() =>
      expect(groupHeader(slot, "todo").getAttribute("aria-expanded")).toBe(
        "false",
      ),
    );
    const header = groupHeader(slot, "todo");
    expect(header.textContent).toContain("Todo");
    // Two parents; the subtasks were never counted here and still are not.
    expect(header.textContent).toContain("2");
    expect(header.querySelector("svg")).not.toBeNull();
  });

  it("hides an expanded parent's subtasks and restores that expansion", async () => {
    const slot = renderList();
    await expandParent(slot);
    await waitFor(() =>
      expect(rowKeys(slot)).toEqual([
        "TSK-1",
        "TSK-2",
        "TSK-3",
        "TSK-5",
        "TSK-4",
      ]),
    );

    fireEvent.click(groupHeader(slot, "todo"));
    await waitFor(() => expect(rowKeys(slot)).toEqual(["TSK-4"]));

    fireEvent.click(groupHeader(slot, "todo"));
    // The parent comes back still expanded: a group collapse is not a reset.
    await waitFor(() =>
      expect(rowKeys(slot)).toEqual([
        "TSK-1",
        "TSK-2",
        "TSK-3",
        "TSK-5",
        "TSK-4",
      ]),
    );
  });

  it("restores the collapsed set on remount, per list surface", async () => {
    const slot = renderList();
    await slot.findByText("TSK-1");
    fireEvent.click(groupHeader(slot, "todo"));
    await waitFor(() => expect(rowKeys(slot)).toEqual(["TSK-4"]));
    slot.lifecycle.unmount();

    const remounted = renderList();
    await remounted.findByText("TSK-4");
    expect(rowKeys(remounted)).toEqual(["TSK-4"]);
    expect(groupHeader(remounted, "todo").getAttribute("aria-expanded")).toBe(
      "false",
    );
    remounted.lifecycle.unmount();

    // All tasks is its own surface: the project's collapse says nothing here.
    const allTasks = renderList("all");
    await allTasks.findByText("TSK-1");
    expect(rowKeys(allTasks)).toContain("TSK-1");
  });
});

describe("the parent expand toggle's hit area", () => {
  it("stretches over the row's whole leading column", async () => {
    const slot = renderList();
    const toggle = await slot.findByRole("button", {
      name: "Expand 2 subtasks of TSK-1",
    });
    // jsdom has no layout, so the stretched hit area is asserted as the
    // pseudo-element that draws it: full row height, leading column width.
    expect(toggle.className).toContain("before:absolute");
    expect(toggle.className).toContain("before:inset-y-0");
    expect(toggle.className).toContain("before:left-0");
    // The glyph itself is untouched.
    expect(toggle.className).toContain("size-4");
  });

  it("collapses the parent from the subtask rail too", async () => {
    const slot = renderList();
    await expandParent(slot);
    const rail = await waitFor(() => {
      const found = slot.container.querySelector<HTMLElement>(
        '[data-subtask-rail="TSK-1"]',
      );
      if (found === null) throw new Error("no subtask rail");
      return found;
    });
    // Same action as the chevron, and deliberately silent to assistive tech:
    // the chevron above is the announced control.
    expect(rail.getAttribute("aria-hidden")).toBe("true");
    // Not a button and carrying no tabindex, so it cannot take focus at all —
    // pointer, script or otherwise. A focusable element that is absent from
    // the accessibility tree is a focus trap for screen-reader users.
    expect(rail.tagName).toBe("DIV");
    expect(rail.hasAttribute("tabindex")).toBe(false);
    rail.focus();
    expect(document.activeElement).not.toBe(rail);

    fireEvent.click(rail);
    await waitFor(() =>
      expect(rowKeys(slot)).toEqual(["TSK-1", "TSK-5", "TSK-4"]),
    );
    expect(
      within(slot.container)
        .getByRole("button", { name: "Expand 2 subtasks of TSK-1" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
