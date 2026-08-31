// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// jsdom lacks matchMedia; the vendored Dialog's responsive root needs it.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

// loadPluginApp installs the fake SDK runtime; nothing SDK-touching may be
// imported before it runs.
const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const BB_PROJECT_ID = "proj_bb0000000000000000000001";
const PARENT_TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";

function projectRow(
  linkedBbProjectId: string | null,
  baseBranch: string | null = null,
) {
  return {
    id: PROJECT_ID,
    name: "Tasks Plugin",
    prefix: "TSK",
    nextTaskNumber: 6,
    color: "blue",
    folderId: null,
    linkedBbProjectId,
    baseBranch,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

const task = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZT5",
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the rail",
  description: "",
  status: "todo",
  priority: "none",
  dueDate: null,
  parentTaskId: null,
  baseBranch: null,
  position: 1,
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  labelIds: [],
};

function detailRpc(
  linkedBbProjectId: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    listProjects: () => ({ projects: [projectRow(linkedBbProjectId)] }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    listTasks: (input: { parentTaskId?: string } | null) =>
      input?.parentTaskId ? { tasks: [] } : { tasks: [task] },
    getTaskByKey: () => ({ task }),
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

describe("dispatch target rail control", () => {
  it("links a discovered bb project", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(null, {
          listBbProjects: () => ({
            bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }],
          }),
          updateProject: (input: Record<string, unknown>) => {
            updateCalls.push(input);
            return {
              project: {
                ...projectRow(input.linkedBbProjectId as string | null),
              },
            };
          },
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Edit dispatch target" }),
    );
    fireEvent.click(await slot.findByLabelText("Linked bb project"));
    fireEvent.click(await slot.findByRole("option", { name: "bb monorepo" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    // The rail writes the link and nothing else — a project's base branch is
    // set in the manage panel.
    expect(updateCalls[0]).toEqual({
      projectId: PROJECT_ID,
      linkedBbProjectId: BB_PROJECT_ID,
    });
  });

  it("shows the linked bb project's name and unlinks it", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listBbProjects: () => ({
            bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }],
          }),
          updateProject: (input: Record<string, unknown>) => {
            updateCalls.push(input);
            return {
              project: {
                ...projectRow(input.linkedBbProjectId as string | null),
              },
            };
          },
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Edit dispatch target",
    });
    await slot.findByText("bb monorepo");

    fireEvent.click(trigger);
    fireEvent.click(await slot.findByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({
      projectId: PROJECT_ID,
      linkedBbProjectId: null,
    });
  });

  it("no longer offers the project's base branch", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listBbProjects: () => ({
            bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }],
          }),
        }),
      },
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Edit dispatch target" }),
    );
    await slot.findByLabelText("Linked bb project");
    expect(slot.queryByLabelText("Project base branch")).toBeNull();
  });
});

describe("task base branch rail control", () => {
  it("sets the task's own branch and clears it back to inherited", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    const rpc = detailRpc(BB_PROJECT_ID, {
      updateTask: (input: Record<string, unknown>) => {
        updateCalls.push(input);
        return { ok: true, task };
      },
    });
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Edit base branch" }),
    );
    fireEvent.change(await slot.findByLabelText("Task base branch"), {
      target: { value: "feature/one" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toMatchObject({ baseBranch: "feature/one" });

    // An empty draft means "inherit", not "a branch named empty string".
    fireEvent.click(
      await slot.findByRole("button", { name: "Edit base branch" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCalls).toHaveLength(2));
    expect(updateCalls[1]).toMatchObject({ baseBranch: null });
  });
  it("reads the project's branch, and says the branch came from the project", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listProjects: () => ({
            projects: [projectRow(BB_PROJECT_ID, "release-redesign")],
          }),
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: /Edit base branch/,
    });
    await waitFor(() =>
      expect(trigger.textContent).toContain("release-redesign"),
    );
    expect(trigger.textContent).toContain("from the project");
  });

  it("attributes an inherited branch to the ancestor that names it", async () => {
    const parentTask = {
      ...task,
      id: PARENT_TASK_ID,
      number: 1,
      key: "TSK-1",
      title: "Redesign epic",
      baseBranch: "epic/redesign",
    };
    const child = { ...task, parentTaskId: PARENT_TASK_ID };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          // The project also names one; the nearer ancestor wins.
          listProjects: () => ({
            projects: [projectRow(BB_PROJECT_ID, "release-redesign")],
          }),
          getTaskByKey: () => ({ task: child }),
          listTasks: (input: { parentTaskId?: string } | null) =>
            input?.parentTaskId ? { tasks: [] } : { tasks: [child] },
          getTask: (input: { taskId: string }) => ({
            task: input.taskId === PARENT_TASK_ID ? parentTask : null,
          }),
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: /Edit base branch/,
    });
    await waitFor(() => expect(trigger.textContent).toContain("epic/redesign"));
    expect(trigger.textContent).toContain("from TSK-1");
  });

  it("falls back to the dispatch preset's branch, then to bb's default", async () => {
    const preset = {
      id: "01HZZZZZZZZZZZZZZZZZZZZZP9",
      name: "implement",
      providerId: "claude-code",
      modelId: "claude-opus-5[1m]",
      reasoningLevel: "medium",
      serviceTier: null,
      permissionMode: "full",
      environmentKind: "new-worktree",
      baseBranch: "trunk",
      machineId: null,
      instructions: "",
      builtin: true,
      createdAt: "2026-07-15T00:00:00.000Z",
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listPresets: () => ({ presets: [preset] }),
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: /Edit base branch/,
    });
    await waitFor(() => expect(trigger.textContent).toContain("trunk"));
    expect(trigger.textContent).toContain("from preset implement");

    cleanup();
    // Nothing anywhere names a branch: bb picks.
    const bare = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc(BB_PROJECT_ID) },
    );
    const bareTrigger = await bare.findByRole("button", {
      name: /Edit base branch/,
    });
    await waitFor(() =>
      expect(bareTrigger.textContent).toContain("bb default"),
    );
  });
});
