// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { COMPACT_VIEWPORT_QUERY } from "@/components/ui/hooks/use-compact-viewport";

// jsdom lacks matchMedia. As in the list-row tests, reporting the compact
// query as matching renders the property menus as their mobile drawers, whose
// plain buttons are clickable in jsdom (unlike Radix menu items).
window.matchMedia = (query: string) => ({
  matches: query === COMPACT_VIEWPORT_QUERY,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const OTHER_PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP2";

const projects = [
  {
    id: PROJECT_ID,
    name: "Tasks Plugin",
    prefix: "TSK",
    nextTaskNumber: 20,
    color: "blue",
    folderId: null,
    linkedBbProjectId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
  },
  {
    id: OTHER_PROJECT_ID,
    name: "Platform",
    prefix: "PLT",
    nextTaskNumber: 3,
    color: "green",
    folderId: null,
    linkedBbProjectId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
  },
];

function task(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZT${number}`,
    projectId: PROJECT_ID,
    number,
    key: `TSK-${number}`,
    title: `Task ${number}`,
    description: "",
    status: "todo",
    priority: "none",
    dueDate: null,
    parentTaskId: null,
    position: number,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    blocked: false,
    unresolvedBlockerCount: 0,
    labelIds: [],
    ...overrides,
  };
}

/** The blocker-list shape: a task reduced to what a relation row shows. */
function blocker(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZT${number}`,
    key: `TSK-${number}`,
    title: `Task ${number}`,
    status: "todo",
    projectId: PROJECT_ID,
    ...overrides,
  };
}

/** One dispatch preset, so the split button renders instead of "Add a preset…". */
const preset = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZE1",
  name: "FB3 BE live worktree",
  providerId: "claude-code",
  modelId: "claude-sonnet-5",
  reasoningLevel: "medium",
  serviceTier: null,
  permissionMode: "accept-edits",
  environmentKind: "new-worktree",
  baseBranch: "main",
  machineId: "mach_1",
  instructions: "",
  builtin: false,
  createdAt: "2026-07-15T00:00:00.000Z",
};

const subject = task(5, {
  title: "Ship the rail",
  blocked: true,
  unresolvedBlockerCount: 1,
});

function detailRpc(overrides: Record<string, unknown> = {}) {
  const tasksByKey = new Map<string, Record<string, unknown>>([
    ["TSK-5", subject],
    ["TSK-9", task(9, { title: "Land the migration" })],
  ]);
  return {
    listProjects: () => ({ projects }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listTasks: (input: { parentTaskId?: string } | null) =>
      input?.parentTaskId ? { tasks: [] } : { tasks: [subject] },
    getTaskByKey: (input: { taskKey: string }) => ({
      task: tasksByKey.get(input.taskKey) ?? null,
    }),
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    listTaskBlockers: () => ({ blockers: [], unresolvedCount: 0 }),
    listTaskBlocking: () => ({ blocking: [] }),
    ...overrides,
  };
}

function renderDetail(overrides: Record<string, unknown> = {}) {
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "task/TSK-5" },
    { rpc: detailRpc(overrides) },
  );
}

describe("task blockers section", () => {
  it("lists unresolved and resolved blockers, keeping the settled ones", async () => {
    const slot = renderDetail({
      listTaskBlockers: () => ({
        blockers: [
          blocker(9, { title: "Land the migration" }),
          blocker(7, { title: "Retire the old table", status: "done" }),
          blocker(2, {
            title: "Cross-project prep",
            projectId: OTHER_PROJECT_ID,
            key: "PLT-2",
          }),
        ],
        unresolvedCount: 2,
      }),
    });

    await slot.findByText("Land the migration");
    // A resolved blocker stays on the list, struck through — that persistence
    // is the record of what used to block this task.
    const resolved = await slot.findByText("Retire the old table");
    expect(resolved.className).toContain("line-through");
    // A blocker in another project names it.
    await slot.findByText("Platform");
  });

  it("shows the reverse reading of the relation", async () => {
    const slot = renderDetail({
      listTaskBlocking: () => ({
        blocking: [blocker(11, { title: "Downstream work" })],
      }),
    });

    await slot.findByText("Blocking");
    await slot.findByText("Downstream work");
    // The reverse list is navigable but not editable from this end.
    expect(slot.queryByRole("button", { name: "Remove blocker TSK-11" })).toBe(
      null,
    );
  });

  it("navigates to a blocker when its row is clicked", async () => {
    const slot = renderDetail({
      listTaskBlockers: () => ({
        blockers: [blocker(9, { title: "Land the migration" })],
        unresolvedCount: 1,
      }),
    });

    fireEvent.click(await slot.findByText("Land the migration"));

    // Same navigation the parent-task link uses: a panel route, not a
    // detail-view-local state change.
    await waitFor(() =>
      expect(
        slot.navigateCalls.some(
          (call) =>
            call.method === "toPluginPanel" &&
            call.options?.subPath === "task/TSK-9",
        ),
      ).toBe(true),
    );
  });

  it("adds a blocker picked from any project", async () => {
    // A mock whose data actually changes: the add lands in the same list the
    // section reads back, so the assertion is the row appearing, not the
    // payload that was sent.
    const stored: Array<Record<string, unknown>> = [];
    const slot = renderDetail({
      listTasks: (input: Record<string, unknown> | null) =>
        input?.parentTaskId
          ? { tasks: [] }
          : {
              tasks: [
                subject,
                task(2, {
                  id: "01HZZZZZZZZZZZZZZZZZZZZO2",
                  projectId: OTHER_PROJECT_ID,
                  key: "PLT-2",
                  title: "Cross-project prep",
                }),
              ],
              nextCursor: null,
            },
      listTaskBlockers: () => ({
        blockers: [...stored],
        unresolvedCount: stored.length,
      }),
      addTaskBlocker: (input: Record<string, unknown>) => {
        stored.push(
          blocker(2, {
            id: input.blockerTaskId,
            key: "PLT-2",
            title: "Cross-project prep",
            projectId: OTHER_PROJECT_ID,
          }),
        );
        return {
          ok: true,
          relation: {
            blockerTaskId: input.blockerTaskId,
            blockedTaskId: input.blockedTaskId,
          },
          added: true,
        };
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add blocker" }));
    expect(slot.queryByRole("button", { name: "Remove blocker PLT-2" })).toBe(
      null,
    );
    fireEvent.click(await slot.findByText("Cross-project prep"));

    await slot.findByRole("button", { name: "Remove blocker PLT-2" });
    expect(stored[0]).toMatchObject({ id: "01HZZZZZZZZZZZZZZZZZZZZO2" });
  });

  it("keeps a rejected cycle readable on the picker", async () => {
    const slot = renderDetail({
      listTasks: (input: Record<string, unknown> | null) =>
        input?.parentTaskId
          ? { tasks: [] }
          : {
              tasks: [subject, task(9, { title: "Land the migration" })],
              nextCursor: null,
            },
      addTaskBlocker: () => ({
        ok: false,
        error: {
          code: "task_blocker_cycle",
          message: "That would create a blocker cycle",
        },
      }),
    });

    fireEvent.click(await slot.findByRole("button", { name: "Add blocker" }));
    fireEvent.click(await slot.findByText("Land the migration"));

    await slot.findByRole("alert");
    await slot.findByText("That would create a blocker cycle");
  });

  it("removes a blocker", async () => {
    const stored = [blocker(9, { title: "Land the migration" })];
    const slot = renderDetail({
      listTaskBlockers: () => ({
        blockers: [...stored],
        unresolvedCount: stored.length,
      }),
      removeTaskBlocker: (input: Record<string, unknown>) => {
        const index = stored.findIndex(
          (entry) => entry.id === input.blockerTaskId,
        );
        if (index === -1) return { removed: false };
        stored.splice(index, 1);
        return { removed: true };
      },
    });

    fireEvent.click(
      await slot.findByRole("button", { name: "Remove blocker TSK-9" }),
    );

    // The row goes because the list behind it changed, not because the click
    // was recorded.
    await waitFor(() => expect(slot.queryByText("Land the migration")).toBe(null));
    expect(stored).toEqual([]);
  });

  it("reads In Progress as unavailable in the rail's status menu", async () => {
    const slot = renderDetail();

    // Container queries do not resolve in jsdom, so both the inline chips and
    // the rail render their status menu; either one must say the same thing.
    const triggers = await slot.findAllByText("Todo");
    fireEvent.click(triggers[0]!.closest("button")!);
    const item = (await slot.findAllByRole("menuitem", {
      name: /In Progress/,
    }))[0]!;
    expect(item.textContent).toContain("Blocked by 1 unresolved task");
    expect(item.getAttribute("data-disabled")).not.toBeNull();
  });

  it("reads dispatch as unavailable while the task is blocked", async () => {
    const slot = renderDetail({ listPresets: () => ({ presets: [preset] }) });

    // Same reading as the status menu: disabled, with the reason as visible
    // text inside the control so it lands in the accessible name.
    const buttons = await slot.findAllByRole("button", {
      name: /Blocked by 1 unresolved task/,
    });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
  });
});
