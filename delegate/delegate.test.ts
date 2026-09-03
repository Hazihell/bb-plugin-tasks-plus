import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "../api";
import type { Comment, Project, Task } from "../db";
import { delegationRpcContract } from "./contract";
import { buildSeedPrompt, registerDelegation } from ".";

function createTestPreset(
  store: ReturnType<typeof createStore>,
  overrides: Partial<{
    environmentKind: "project-default" | "new-worktree";
    baseBranch: string | null;
    machineId: string | null;
  }> = {},
) {
  return store.tasks.createPreset({
    name: "Test worker",
    providerId: "claude-code",
    modelId: "claude-sonnet-5",
    reasoningLevel: "high",
    serviceTier: "fast",
    permissionMode: "full",
    environmentKind: overrides.environmentKind ?? "project-default",
    baseBranch: overrides.baseBranch ?? null,
    machineId: overrides.machineId ?? null,
    instructions: "",
    builtin: false,
  });
}

describe("task delegation", () => {
  it("spawns from a preset, attaches the thread, advances status, comments, and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_delegated" }),
          get: async () =>
            makeThreadResponse({ id: "thr_delegated", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Tasks plugin",
      prefix: "TASK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Implement delegation",
      description: "Build the core agent loop.",
      status: "todo",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    const result = delegationRpcContract.delegate.output.parse(
      await harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: "Run the focused tests before reporting back.",
      }),
    );

    expect(result).toEqual({ threadId: "thr_delegated" });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_bb",
          environment: { type: "project-default" },
          providerId: "claude-code",
          model: "claude-sonnet-5",
          reasoningLevel: "high",
          serviceTier: "fast",
          permissionMode: "full",
          title: "TASK-1 · Implement delegation",
          prompt: expect.stringContaining(
            "Run the focused tests before reporting back.",
          ),
          origin: "plugin",
          originPluginId: "tasks",
        }),
      ],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        taskId: task.id,
        threadId: "thr_delegated",
        presetName: "Test worker",
        title: "TASK-1 · Implement delegation",
        liveStatus: "starting",
      }),
    ]);
    expect(store.tasks.getTask(task.id)?.status).toBe("in_progress");
    expect(store.tasks.listComments(task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Status changed to In Progress · dispatched to Test worker",
        }),
        expect.objectContaining({
          kind: "system",
          authorName: "Tasks",
          presetName: "Test worker",
          threadId: "thr_delegated",
          body: "Dispatched to Test worker",
        }),
      ]),
    );
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
      { channel: "comments:changed", payload: { taskId: task.id } },
    ]);

    await harness.dispose();
  });

  it("spawns a task into its own dispatch target over the project target", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_task_target" }),
          get: async () =>
            makeThreadResponse({ id: "thr_task_target", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Task target",
      prefix: "TGT",
      color: "blue",
      linkedBbProjectId: "proj_project",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Dispatch to the task target",
      dispatchBbProjectId: "proj_task",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_task",
          prompt: expect.stringContaining(
            "- Linked bb project: proj_task (from this task)",
          ),
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("spawns a sub-task into its parent's dispatch target when it has none", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_parent_target" }),
          get: async () =>
            makeThreadResponse({
              id: "thr_parent_target",
              status: "starting",
            }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Parent target",
      prefix: "PAR",
      color: "blue",
      linkedBbProjectId: "proj_project",
    });
    const parent = store.tasks.createTask({
      projectId: project.id,
      title: "Parent",
      dispatchBbProjectId: "proj_parent",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Child",
      parentTaskId: parent.id,
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_parent",
          prompt: expect.stringContaining(
            `- Linked bb project: proj_parent (from ${parent.key})`,
          ),
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("spawns a task with no own or ancestor target into the project target", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_project_target" }),
          get: async () =>
            makeThreadResponse({
              id: "thr_project_target",
              status: "starting",
            }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Project target",
      prefix: "PRJ",
      color: "blue",
      linkedBbProjectId: "proj_project",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use the project target",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", { taskId: task.id, presetId: preset.id });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [expect.objectContaining({ projectId: "proj_project" })],
    ]);

    await harness.dispose();
  });

  it("corrects the attached row when a delegated thread becomes active immediately", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_fast" }),
          get: async () =>
            makeThreadResponse({ id: "thr_fast", status: "active" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Fast delegation",
      prefix: "FAST",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Transition during spawn",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_fast" }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_fast",
        liveStatus: "working",
      }),
    ]);

    await harness.dispose();
  });

  it("spawns a new worktree from the configured branch on the configured machine", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_worktree" }),
          get: async () =>
            makeThreadResponse({ id: "thr_worktree", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Worktree delegation",
      prefix: "WT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use a fresh checkout",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "release/next",
      machineId: "host_remote",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_remote",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "release/next" },
            },
          },
        }),
      ],
    ]);
    expect(harness.sdk.callsTo("system.config")).toEqual([]);

    await harness.dispose();
  });

  it("resolves the default machine and default branch for a worktree preset", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        system: {
          config: async () => ({ primaryHostId: "host_primary" }),
        },
        threads: {
          spawn: async () => ({ id: "thr_default_worktree" }),
          get: async () =>
            makeThreadResponse({
              id: "thr_default_worktree",
              status: "starting",
            }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Default worktree target",
      prefix: "DWT",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Use default worktree target",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("system.config")).toEqual([[]]);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: {
            type: "host",
            hostId: "host_primary",
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "default" },
            },
          },
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("dispatches a sub-task from the nearest branch its ancestry names", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_inherited" }),
          get: async () =>
            makeThreadResponse({ id: "thr_inherited", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Inheriting project",
      prefix: "INH",
      color: "blue",
      linkedBbProjectId: "proj_demo",
      baseBranch: "project-branch",
    });
    const parent = store.tasks.createTask({
      projectId: project.id,
      title: "Parent epic",
      baseBranch: "parent-branch",
    });
    const subtask = store.tasks.createTask({
      projectId: project.id,
      title: "Sub-task without its own branch",
      parentTaskId: parent.id,
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "preset-branch",
      machineId: "host_remote",
    });

    await harness.callRpc("delegate", {
      taskId: subtask.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: expect.objectContaining({
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "parent-branch" },
            },
          }),
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("dispatches from the task's own branch over its project and preset", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_own_branch" }),
          get: async () =>
            makeThreadResponse({ id: "thr_own_branch", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Overriding project",
      prefix: "OVR",
      color: "blue",
      linkedBbProjectId: "proj_demo",
      baseBranch: "project-branch",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Task with its own branch",
      baseBranch: "task-branch",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "preset-branch",
      machineId: "host_remote",
    });

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          environment: expect.objectContaining({
            workspace: {
              type: "managed-worktree",
              baseBranch: { kind: "named", name: "task-branch" },
            },
          }),
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("names the resolved branch, not the preset's, when the spawn is rejected", async () => {
    const spawnError = Object.assign(
      new Error("HTTP 400: Unknown base branch"),
      { code: "invalid_request", status: 400 },
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => {
            throw spawnError;
          },
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Resolved branch error",
      prefix: "RBE",
      color: "blue",
      linkedBbProjectId: "proj_demo",
      baseBranch: "project-branch",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Reject the project branch",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "preset-branch",
      machineId: "host_missing",
    });

    await expect(
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message:
        "Could not create a worktree on host_missing from project-branch: Unknown base branch",
    });

    await harness.dispose();
  });

  it("maps a rejected worktree target to a friendly typed delegation error", async () => {
    const spawnError = Object.assign(new Error("HTTP 404: Host not found"), {
      code: "host_not_found",
      status: 404,
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => {
            throw spawnError;
          },
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Invalid target",
      prefix: "BAD",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Reject bad machine",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store, {
      environmentKind: "new-worktree",
      baseBranch: "missing-branch",
      machineId: "host_missing",
    });

    await expect(
      harness.callRpc("delegate", {
        taskId: task.id,
        presetId: preset.id,
      }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message:
        "Could not create a worktree on host_missing from missing-branch: Host not found",
    });

    await harness.dispose();
  });

  it("fails before spawning when the task project is not linked to bb", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { spawn: async () => ({ id: "thr_never" }) } },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Unlinked",
      prefix: "UNL",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Cannot delegate yet",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await expect(
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: "No dispatch target resolved for task UNL-1",
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);

    await harness.dispose();
  });

  it("refuses to dispatch a task with unresolved blockers before spawning", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { spawn: async () => ({ id: "thr_never" }) } },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Blocked dispatch",
      prefix: "BD",
      color: "blue",
      linkedBbProjectId: "proj_demo",
    });
    const blocker = store.tasks.createTask({
      projectId: project.id,
      title: "Unfinished prerequisite",
      status: "todo",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Blocked work",
    });
    store.tasks.addTaskBlocker({
      blockerTaskId: blocker.id,
      blockedTaskId: task.id,
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await expect(
      harness.callRpc("delegate", { taskId: task.id, presetId: preset.id }),
    ).rejects.toMatchObject({
      code: "handler_error",
      message: expect.stringContaining(
        `Cannot dispatch ${task.key} is blocked by unresolved task: ${blocker.key}`,
      ),
    });
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([]);

    await harness.dispose();
  });

  it("seeds the dispatched worker with the task's own artifacts", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_artifacts" }),
          get: async () =>
            makeThreadResponse({ id: "thr_artifacts", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Artifact delegation",
      prefix: "ART",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Carry the record forward",
    });
    const other = store.tasks.createTask({
      projectId: project.id,
      title: "Unrelated work",
    });
    const artifact = store.tasks.createTaskArtifact({
      taskId: task.id,
      kind: "decision",
      title: "Formatter owns the cap",
      metadata: {
        discovery: "Manifests grew unbounded",
        decision: "Cap each kind at ten",
        why: "Seed prompts must stay bounded",
        impact: "Older records need one CLI call",
      },
    });
    store.tasks.createTaskArtifact({
      taskId: other.id,
      kind: "decision",
      title: "Belongs to another task",
    });
    registerDelegation(bb, store);
    const preset = createTestPreset(store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: preset.id,
    });

    const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [
      [{ prompt: string }],
    ];
    expect(spawn.prompt).toContain("### Decision");
    expect(spawn.prompt).toContain(`- Formatter owns the cap · ${artifact.id}`);
    expect(spawn.prompt).not.toContain("Belongs to another task");

    await harness.dispose();
  });

  it("seeds parent, resolved blockers, human feedback, and the latest handoff", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          spawn: async () => ({ id: "thr_packet" }),
          get: async () =>
            makeThreadResponse({ id: "thr_packet", status: "starting" }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Packet delegation",
      prefix: "PACK",
      color: "blue",
      linkedBbProjectId: "proj_bb",
    });
    const parent = store.tasks.createTask({
      projectId: project.id,
      title: "Parent goal",
      description: "Preserve the parent contract.",
    });
    const blocker = store.tasks.createTask({
      projectId: project.id,
      title: "Published dependency",
      status: "done",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      parentTaskId: parent.id,
      title: "Consume the dependency",
    });
    store.tasks.addTaskBlocker({
      blockerTaskId: blocker.id,
      blockedTaskId: task.id,
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "system",
      authorName: "Tasks",
      body: "Internal status noise",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "Reviewer",
      body: "Keep the public wording.",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Old worker",
      body: "Superseded handoff",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Current worker",
      body: "Current handoff",
    });
    registerDelegation(bb, store);

    await harness.callRpc("delegate", {
      taskId: task.id,
      presetId: createTestPreset(store).id,
    });

    const [[spawn]] = harness.sdk.callsTo("threads.spawn") as [
      [{ prompt: string }],
    ];
    expect(spawn.prompt).toContain(`${parent.key} · Parent goal`);
    expect(spawn.prompt).toContain("Preserve the parent contract.");
    expect(spawn.prompt).toContain(
      `${blocker.key} · Published dependency (done)`,
    );
    expect(spawn.prompt).toContain("Keep the public wording.");
    expect(spawn.prompt).toContain("Current handoff");
    expect(spawn.prompt).not.toContain("Internal status noise");
    expect(spawn.prompt).not.toContain("Superseded handoff");

    await harness.dispose();
  });

  it("self-attaches an existing thread through taskThreadsAttach", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_existing",
            title: "Existing worker",
            titleFallback: null,
            status: "active",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach current worker",
    });
    registerDelegation(bb, store);

    await expect(
      harness.callRpc("taskThreadsAttach", {
        taskId: task.id,
        threadId: "thr_existing",
      }),
    ).resolves.toEqual({ threadId: "thr_existing" });
    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_existing" }],
    ]);
    expect(store.tasks.listTaskThreads(task.id)).toEqual([
      expect.objectContaining({
        threadId: "thr_existing",
        presetName: "Attached",
        title: "Existing worker",
        liveStatus: "working",
      }),
    ]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    await harness.dispose();
  });
});

describe("task thread detach", () => {
  it("detaches an attached thread through taskThreadsDetach and invalidates", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: threadId === "thr_dead" ? "error" : "idle",
          }),
        },
      },
    });
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Manual",
      prefix: "MAN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Respawned work",
    });
    const otherTask = store.tasks.createTask({
      projectId: project.id,
      title: "Other work",
    });
    registerDelegation(bb, store);

    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_dead",
    });
    await harness.callRpc("taskThreadsAttach", {
      taskId: task.id,
      threadId: "thr_live",
    });
    // The same thread attached to a second task must survive a detach from
    // the first one.
    await harness.callRpc("taskThreadsAttach", {
      taskId: otherTask.id,
      threadId: "thr_dead",
    });
    harness.realtimeSignals.length = 0;

    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).resolves.toEqual({ threadId: "thr_dead" });

    expect(
      store.tasks.listTaskThreads(task.id).map((thread) => thread.threadId),
    ).toEqual(["thr_live"]);
    expect(
      store.tasks
        .listTaskThreads(otherTask.id)
        .map((thread) => thread.threadId),
    ).toEqual(["thr_dead"]);
    expect(harness.realtimeSignals).toEqual([
      { channel: "threads:changed", payload: { taskId: task.id } },
      {
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      },
    ]);

    // Detaching a thread that is not attached is an error, not a no-op.
    await expect(
      harness.callRpc("taskThreadsDetach", {
        taskId: task.id,
        threadId: "thr_dead",
      }),
    ).rejects.toThrow(`Thread thr_dead is not attached to ${task.key}`);

    await harness.dispose();
  });
});

describe("delegation seed prompt", () => {
  it("captures task context and the complete report-back contract", () => {
    const project: Project = {
      id: "01J00000000000000000000001",
      name: "Tasks plugin",
      prefix: "TASK",
      nextTaskNumber: 4,
      color: "blue",
      folderId: null,
      linkedBbProjectId: "proj_tasks",
      createdAt: "2026-07-15T17:00:00.000Z",
    };
    const task: Task = {
      id: "01J00000000000000000000002",
      projectId: project.id,
      number: 1,
      key: "TASK-1",
      title: "Delegate work",
      description:
        "Implement **preset-driven** delegation.\n\nKeep the prompt useful.",
      status: "todo",
      priority: "high",
      dueDate: null,
      parentTaskId: null,
      baseBranch: null,
      dispatchBbProjectId: null,
      position: 1_024,
      createdAt: "2026-07-15T17:01:00.000Z",
      updatedAt: "2026-07-15T17:01:00.000Z",
    };
    const subtask: Task = {
      ...task,
      id: "01J00000000000000000000003",
      number: 2,
      key: "TASK-2",
      title: "Add focused tests",
      status: "in_progress",
      parentTaskId: task.id,
    };
    const comments: Comment[] = [
      {
        id: "01J00000000000000000000004",
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        presetName: null,
        threadId: null,
        body: "Preserve the existing domain path.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:02:00.000Z",
      },
      {
        id: "01J00000000000000000000005",
        taskId: task.id,
        kind: "agent",
        authorName: "Worker",
        presetName: "Sonnet · high",
        threadId: "thr_prior",
        body: "The schema study is complete.",
        notifiedCount: 0,
        createdAt: "2026-07-15T17:03:00.000Z",
      },
    ];

    expect(
      buildSeedPrompt({
        task,
        parent: null,
        parentDirection: null,
        blockers: [],
        project,
        dispatchTarget: {
          bbProjectId: "proj_tasks",
          scope: "project",
          ancestorKey: null,
        },
        subtasks: [subtask],
        artifacts: [
          {
            id: "01J00000000000000000000007",
            kind: "approved_plan",
            title: "Approved delegation plan",
            createdAt: "2026-07-15T17:00:30.000Z",
          },
        ],
        attachments: [
          {
            id: "01J00000000000000000000006",
            fileName: "delegation-notes.md",
          },
        ],
        recentComments: comments,
        presetInstructions: "Prefer focused changes.",
        extraInstructions: "Run the backend gates.",
      }),
    ).toMatchInlineSnapshot(`
      "# TASK-1 · Delegate work

      ## Description

      Implement **preset-driven** delegation.

      Keep the prompt useful.

      ## Project context

      - Name: Tasks plugin
      - Linked bb project: proj_tasks (from the project)

      ## Parent

      None.

      ## Blocked by

      None.

      ## Sub-tasks

      - TASK-2 · Add focused tests (in_progress)

      ## Artifacts

      ### Approved Plan
      - Approved delegation plan · 01J00000000000000000000007
        Fetch with: bb tasks-plus artifact show 01J00000000000000000000007

      ## Attachments

      - delegation-notes.md · 01J00000000000000000000006
        Fetch with: bb tasks-plus attachment get 01J00000000000000000000006 --out <path>

      ## Recent comments

      ### Sawyer · user · 2026-07-15T17:02:00.000Z

      Preserve the existing domain path.

      ### Worker · agent · 2026-07-15T17:03:00.000Z

      The schema study is complete.

      ## Report-back contract

      You are working on task TASK-1. Use the bb tasks-plus CLI: comment substantive updates (bb tasks-plus comment TASK-1 --body ...), attach result artifacts, set status when done (bb tasks-plus update TASK-1 --status in_review) or explain blockage in a comment. Your thread is already attached to the task.

      ## Preset instructions

      Prefer focused changes.

      ## Additional instructions

      Run the backend gates.
      "
    `);
  });

  it("reads None. when the task carries no artifacts", () => {
    const project: Project = {
      id: "01J00000000000000000000001",
      name: "Tasks plugin",
      prefix: "TASK",
      nextTaskNumber: 2,
      color: "blue",
      folderId: null,
      linkedBbProjectId: "proj_tasks",
      createdAt: "2026-07-15T17:00:00.000Z",
    };
    const task: Task = {
      id: "01J00000000000000000000002",
      projectId: project.id,
      number: 1,
      key: "TASK-1",
      title: "Delegate work",
      description: "",
      status: "todo",
      priority: "none",
      dueDate: null,
      parentTaskId: null,
      baseBranch: null,
      dispatchBbProjectId: null,
      position: 1_024,
      createdAt: "2026-07-15T17:01:00.000Z",
      updatedAt: "2026-07-15T17:01:00.000Z",
    };

    expect(
      buildSeedPrompt({
        task,
        parent: null,
        parentDirection: null,
        blockers: [],
        project,
        dispatchTarget: {
          bbProjectId: "proj_tasks",
          scope: "project",
          ancestorKey: null,
        },
        subtasks: [],
        artifacts: [],
        attachments: [],
        recentComments: [],
        presetInstructions: "",
      }),
    ).toContain("## Artifacts\n\nNone.");
  });

  describe("the Parent section", () => {
    const base = {
      blockers: [],
      project: {
        id: "01J00000000000000000000001",
        prefix: "TASK",
        name: "Tasks plugin",
        description: "",
        folderId: null,
        nextTaskNumber: 3,
        baseBranch: null,
        dispatchBbProjectId: null,
        createdAt: "2026-07-15T17:00:00.000Z",
        updatedAt: "2026-07-15T17:00:00.000Z",
      } as Project,
      dispatchTarget: {
        bbProjectId: "proj_tasks",
        scope: "project" as const,
        ancestorKey: null,
      },
      subtasks: [],
      artifacts: [],
      attachments: [],
      recentComments: [],
      presetInstructions: "",
    };
    const task: Task = {
      id: "01J00000000000000000000003",
      projectId: base.project.id,
      number: 2,
      key: "TASK-2",
      title: "Slice one",
      description: "Build the seam.",
      status: "todo",
      priority: "none",
      dueDate: null,
      parentTaskId: "01J00000000000000000000002",
      baseBranch: null,
      dispatchBbProjectId: null,
      position: 1_024,
      createdAt: "2026-07-15T17:01:00.000Z",
      updatedAt: "2026-07-15T17:01:00.000Z",
    };
    const parent: Task = {
      ...task,
      id: "01J00000000000000000000002",
      number: 1,
      key: "TASK-1",
      title: "The feature",
      parentTaskId: null,
      description:
        "## Goal\n\nMake it work.\n\nDelivery: branch only\n\n## User Stories\n\n1. As a user…",
    };

    it("carries the Goal section, the direction and a pointer to the rest", () => {
      const prompt = buildSeedPrompt({
        ...base,
        task,
        parent,
        parentDirection: "## Boundaries\n\nOne seam.",
      });
      expect(prompt).toContain(
        "## Parent\n\n- TASK-1 · The feature\n\nMake it work.\n\nDelivery: branch only\n\n### Direction\n\n## Boundaries\n\nOne seam.\n\nEverything else about the parent: bb tasks-plus show TASK-1",
      );
      expect(prompt).not.toContain("User Stories");
    });

    it("falls back to the first paragraph and omits Direction without one", () => {
      const prompt = buildSeedPrompt({
        ...base,
        task,
        parent: { ...parent, description: "Plain goal.\n\nMore detail." },
        parentDirection: null,
      });
      expect(prompt).toContain("- TASK-1 · The feature\n\nPlain goal.\n\nEverything else");
      expect(prompt).not.toContain("### Direction");
      expect(prompt).not.toContain("More detail");
    });
  });
});
