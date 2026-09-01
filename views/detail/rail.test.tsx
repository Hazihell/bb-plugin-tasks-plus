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
const OTHER_BB_PROJECT_ID = "proj_bb0000000000000000000002";
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
  dispatchBbProjectId: null,
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
  it("reads the task's own target and attributes it to the task", async () => {
    const owned = { ...task, dispatchBbProjectId: OTHER_BB_PROJECT_ID };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listBbProjects: () => ({
            bbProjects: [
              { id: BB_PROJECT_ID, name: "bb monorepo" },
              { id: OTHER_BB_PROJECT_ID, name: "bb sandbox" },
            ],
          }),
          getTaskByKey: () => ({ task: owned }),
          listTasks: (input: { parentTaskId?: string } | null) =>
            input?.parentTaskId ? { tasks: [] } : { tasks: [owned] },
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Edit dispatch target",
    });
    // The project names one too; the task's own wins and says so.
    await waitFor(() => expect(trigger.textContent).toContain("bb sandbox"));
    expect(trigger.textContent).toContain("from this task");
    expect(slot.getByText(/bb sandbox/).className).not.toContain(
      "text-muted-foreground",
    );
  });

  it("reads an inherited target muted, attributed to the project", async () => {
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
    const trigger = await slot.findByRole("button", {
      name: "Edit dispatch target",
    });
    await waitFor(() => expect(trigger.textContent).toContain("bb monorepo"));
    expect(trigger.textContent).toContain("from the project");
    expect(slot.getByText(/bb monorepo/).className).toContain(
      "text-muted-foreground",
    );
  });

  it("attributes an inherited target to the ancestor that names it", async () => {
    const getTaskCalls: string[] = [];
    const parentTask = {
      ...task,
      id: PARENT_TASK_ID,
      number: 1,
      key: "TSK-1",
      title: "Redesign epic",
      dispatchBbProjectId: OTHER_BB_PROJECT_ID,
    };
    const child = { ...task, parentTaskId: PARENT_TASK_ID };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listBbProjects: () => ({ bbProjects: [] }),
          getTaskByKey: () => ({ task: child }),
          listTasks: (input: { parentTaskId?: string } | null) =>
            input?.parentTaskId ? { tasks: [] } : { tasks: [child] },
          getTask: (input: { taskId: string }) => {
            getTaskCalls.push(input.taskId);
            return {
              task: input.taskId === PARENT_TASK_ID ? parentTask : null,
            };
          },
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: "Edit dispatch target",
    });
    // listBbProjects knows no name for it, so the id stands in.
    await waitFor(() =>
      expect(trigger.textContent).toContain(OTHER_BB_PROJECT_ID),
    );
    expect(trigger.textContent).toContain("from TSK-1");
    // Task/project data settles through multiple query generations. A single
    // combined query makes one parent lookup per generation; separate branch
    // and target queries made four in this harness.
    expect(getTaskCalls.length).toBeLessThan(4);
  });

  it("invites a link when no scope names a bb project", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc(null) },
    );
    const trigger = await slot.findByRole("button", {
      name: "Edit dispatch target",
    });
    await waitFor(() =>
      expect(trigger.textContent).toContain("Link a bb project…"),
    );
  });

  it("saves the task's own target and clears it back to inherited", async () => {
    const updateTaskCalls: Array<Record<string, unknown>> = [];
    const updateProjectCalls: Array<Record<string, unknown>> = [];
    const owned = { ...task, dispatchBbProjectId: OTHER_BB_PROJECT_ID };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          listBbProjects: () => ({
            bbProjects: [
              { id: BB_PROJECT_ID, name: "bb monorepo" },
              { id: OTHER_BB_PROJECT_ID, name: "bb sandbox" },
            ],
          }),
          getTaskByKey: () => ({ task: owned }),
          listTasks: (input: { parentTaskId?: string } | null) =>
            input?.parentTaskId ? { tasks: [] } : { tasks: [owned] },
          updateTask: (input: Record<string, unknown>) => {
            updateTaskCalls.push(input);
            return { ok: true, task: owned };
          },
          updateProject: (input: Record<string, unknown>) => {
            updateProjectCalls.push(input);
            return { project: projectRow(BB_PROJECT_ID) };
          },
        }),
      },
    );

    fireEvent.click(
      await slot.findByRole("button", { name: "Edit dispatch target" }),
    );
    fireEvent.click(await slot.findByLabelText("Task dispatch target"));
    fireEvent.click(await slot.findByRole("option", { name: "bb monorepo" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateTaskCalls).toHaveLength(1));
    expect(updateTaskCalls[0]).toMatchObject({
      dispatchBbProjectId: BB_PROJECT_ID,
    });

    fireEvent.click(
      await slot.findByRole("button", { name: "Edit dispatch target" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Inherit" }));
    await waitFor(() => expect(updateTaskCalls).toHaveLength(2));
    expect(updateTaskCalls[1]).toMatchObject({ dispatchBbProjectId: null });

    // The project's link is the manage panel's business now.
    expect(updateProjectCalls).toEqual([]);
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
  it("attributes the task's own branch to the task", async () => {
    const owned = { ...task, baseBranch: "feature/own" };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc(BB_PROJECT_ID, {
          // Broader scopes name branches too; the task's own still wins, and
          // the read-out has to say so rather than show a bare name.
          listProjects: () => ({
            projects: [projectRow(BB_PROJECT_ID, "release-redesign")],
          }),
          getTaskByKey: () => ({ task: owned }),
          listTasks: (input: { parentTaskId?: string } | null) =>
            input?.parentTaskId ? { tasks: [] } : { tasks: [owned] },
        }),
      },
    );
    const trigger = await slot.findByRole("button", {
      name: /Edit base branch/,
    });
    await waitFor(() => expect(trigger.textContent).toContain("feature/own"));
    expect(trigger.textContent).toContain("from this task");
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
