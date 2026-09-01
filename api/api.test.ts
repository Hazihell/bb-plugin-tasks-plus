import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { buildAttachmentUrl, registerAttachments } from "../attachments";
import {
  TASK_ARTIFACT_KINDS,
  tasksRpcContract,
} from "../shared/contract";
import { createComment, createStore, registerTasksApi } from ".";

describe("Tasks RPC domain API", () => {
  it("deletes through the typed RPC policy and rejects saved-description references", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerAttachments(bb, store.tasks);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Attachments",
      prefix: "ATT",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Referenced image",
    });
    const uploaded = await harness.fetchHttp(
      "POST",
      `/attachments/upload?taskId=${task.id}&fileName=diagram.png&mime=image%2Fpng`,
      { body: "image", headers: { "content-type": "image/png" } },
    );
    const { attachmentId } = (await uploaded.json()) as {
      attachmentId: string;
    };
    store.tasks.updateTask(task.id, {
      description: `![diagram](${buildAttachmentUrl(attachmentId)})`,
    });
    const signalsBeforeConflict = harness.realtimeSignals.length;

    const conflict = tasksRpcContract.deleteAttachment.output.parse(
      await harness.callRpc("deleteAttachment", { attachmentId }),
    );
    expect(conflict).toEqual({
      ok: false,
      error: {
        code: "attachment_referenced",
        message:
          'Attachment "diagram.png" is used in the task description. Remove it from the description before deleting the attachment.',
      },
    });
    expect(store.tasks.getAttachment(attachmentId)).toBeDefined();
    expect(harness.realtimeSignals).toHaveLength(signalsBeforeConflict);

    const deleted = tasksRpcContract.deleteAttachment.output.parse(
      await harness.callRpc("deleteAttachment", {
        attachmentId,
        removeDescriptionReferences: true,
      }),
    );
    expect(deleted).toMatchObject({
      ok: true,
      deleted: true,
      attachment: { id: attachmentId },
    });
    expect(store.tasks.getAttachment(attachmentId)).toBeUndefined();
    expect(store.tasks.getTask(task.id)?.description).toBe("");
    expect(harness.realtimeSignals.at(-1)).toEqual({
      channel: "tasks:changed",
      payload: { taskId: task.id, projectId: project.id },
    });

    await expect(
      harness.callRpc("deleteAttachment", { attachmentId }),
    ).resolves.toEqual({ ok: true, deleted: false, attachment: null });
    await harness.dispose();
  });

  it("persists one successful notification to the latest replying agent", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({ id: threadId, status: "active" }),
          send: async () => undefined,
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Notifications",
      prefix: "NTF",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Notify workers",
    });
    for (const [threadId, liveStatus] of [
      ["thr_one", "working"],
      ["thr_two", "working"],
      ["thr_done", "completed"],
    ] as const) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus,
      });
    }
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "First agent",
      threadId: "thr_one",
      body: "First reply",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Second agent",
      threadId: "thr_two",
      body: "Latest reply",
    });

    const result = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "Keep both workers aligned.",
        notify: true,
      }),
    );

    expect(result.comment.notifiedCount).toBe(1);
    expect(store.tasks.getComment(result.comment.id)?.notifiedCount).toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [expect.objectContaining({ threadId: "thr_two" })],
    ]);
    expect(harness.realtimeSignals.at(-1)).toEqual({
      channel: "comments:changed",
      payload: { taskId: task.id, notifiedCount: 1 },
    });
    await harness.dispose();
  });

  it("resolves the live thread title for agent comments and falls back otherwise", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_titled") {
              return makeThreadResponse({
                id: threadId,
                title: "Fix the login bug",
              });
            }
            if (threadId === "thr_fallback_only") {
              return makeThreadResponse({
                id: threadId,
                title: null,
                titleFallback: "Untitled work",
              });
            }
            if (threadId === "thr_blank_title") {
              // A whitespace primary title must not suppress a useful fallback.
              return makeThreadResponse({
                id: threadId,
                title: "   ",
                titleFallback: "Recovered fallback",
              });
            }
            if (threadId === "thr_side_chat") {
              return makeThreadResponse({
                id: threadId,
                title: "Internal side chat",
                originKind: "fork",
                originPluginId: "side-chat",
                visibility: "hidden",
              });
            }
            // Deleted / hidden / inaccessible threads reject.
            throw new Error("thread_not_found");
          },
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Notifications",
      prefix: "NTF",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Wire up comments",
    });
    // Agent comment whose thread has a human title.
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_titled)",
      threadId: "thr_titled",
      body: "Titled",
      notifiedCount: 0,
    });
    // Agent comment whose thread only has a fallback title.
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_fallback_only)",
      threadId: "thr_fallback_only",
      body: "Fallback title",
      notifiedCount: 0,
    });
    // Agent comment whose thread has only a whitespace primary title.
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_blank_title)",
      threadId: "thr_blank_title",
      body: "Blank title",
      notifiedCount: 0,
    });
    // Agent comment authored by a side chat (must not leak title/link).
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_side_chat)",
      threadId: "thr_side_chat",
      body: "Side chat",
      notifiedCount: 0,
    });
    // Agent comment whose thread is gone/inaccessible.
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (thr_missing)",
      threadId: "thr_missing",
      body: "Missing thread",
      notifiedCount: 0,
    });
    // Legacy agent comment with no thread id.
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "agent (legacy)",
      threadId: null,
      body: "Legacy",
      notifiedCount: 0,
    });
    // User comment never resolves a thread title.
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "You",
      threadId: null,
      body: "Human note",
      notifiedCount: 0,
    });

    const result = tasksRpcContract.listComments.output.parse(
      await harness.callRpc("listComments", { taskId: task.id }),
    );
    const titleByBody = new Map(
      result.comments.map((comment) => [comment.body, comment.threadTitle]),
    );
    expect(titleByBody.get("Titled")).toBe("Fix the login bug");
    expect(titleByBody.get("Fallback title")).toBe("Untitled work");
    expect(titleByBody.get("Blank title")).toBe("Recovered fallback");
    expect(titleByBody.get("Side chat")).toBeNull();
    expect(titleByBody.get("Missing thread")).toBeNull();
    expect(titleByBody.get("Legacy")).toBeNull();
    expect(titleByBody.get("Human note")).toBeNull();
    // Each distinct agent thread is resolved once, not per comment.
    expect(harness.sdk.callsTo("threads.get")).toHaveLength(5);
    await harness.dispose();
  });

  it("resolves the authoring provider badge for agent comments and falls back otherwise", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_codex") {
              return makeThreadResponse({ id: threadId, providerId: "codex" });
            }
            if (threadId === "thr_custom") {
              return makeThreadResponse({
                id: threadId,
                providerId: "acp-custom",
              });
            }
            if (threadId === "thr_side_chat") {
              // Side chats suppress the title/link but still expose a provider.
              return makeThreadResponse({
                id: threadId,
                title: "Internal side chat",
                originKind: "fork",
                originPluginId: "side-chat",
                visibility: "hidden",
                providerId: "claude-code",
              });
            }
            if (threadId === "thr_uninstalled") {
              return makeThreadResponse({
                id: threadId,
                providerId: "acp-gone",
              });
            }
            throw new Error("thread_not_found");
          },
        },
        providers: {
          list: async () => [
            { id: "codex", displayName: "Codex", logoUrl: null },
            { id: "claude-code", displayName: "Claude Code", logoUrl: null },
            {
              id: "acp-custom",
              displayName: "Custom Agent",
              logoUrl: "/api/v1/system/providers/acp-custom/logo",
            },
          ],
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Providers",
      prefix: "PRV",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Provider badges",
    });
    const agentComment = (body: string, threadId: string | null): void => {
      store.tasks.createComment({
        taskId: task.id,
        kind: "agent",
        authorName: `agent (${threadId ?? "legacy"})`,
        threadId,
        body,
        notifiedCount: 0,
      });
    };
    agentComment("Codex", "thr_codex");
    agentComment("Custom logo", "thr_custom");
    agentComment("Side chat", "thr_side_chat");
    agentComment("Uninstalled", "thr_uninstalled");
    agentComment("Missing thread", "thr_missing");
    agentComment("Legacy", null);
    store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "You",
      threadId: null,
      body: "Human note",
      notifiedCount: 0,
    });

    const result = tasksRpcContract.listComments.output.parse(
      await harness.callRpc("listComments", { taskId: task.id }),
    );
    const byBody = new Map(
      result.comments.map((comment) => [comment.body, comment]),
    );
    // Built-in provider resolves its display name; built-ins carry no logoUrl.
    expect(byBody.get("Codex")?.provider).toEqual({
      id: "codex",
      name: "Codex",
      logoUrl: null,
    });
    // Custom ACP agent carries the served logo asset URL.
    expect(byBody.get("Custom logo")?.provider).toEqual({
      id: "acp-custom",
      name: "Custom Agent",
      logoUrl: "/api/v1/system/providers/acp-custom/logo",
    });
    // Side chat: provider present (drives the logo) though the title is hidden.
    expect(byBody.get("Side chat")?.provider).toEqual({
      id: "claude-code",
      name: "Claude Code",
      logoUrl: null,
    });
    expect(byBody.get("Side chat")?.threadTitle).toBeNull();
    // Provider no longer installed: badge falls back to the raw provider id so
    // the UI can still render a brand glyph by id.
    expect(byBody.get("Uninstalled")?.provider).toEqual({
      id: "acp-gone",
      name: "acp-gone",
      logoUrl: null,
    });
    // Inaccessible thread, legacy no-thread agent comment, and user comment
    // carry no provider.
    expect(byBody.get("Missing thread")?.provider).toBeNull();
    expect(byBody.get("Legacy")?.provider).toBeNull();
    expect(byBody.get("Human note")?.provider).toBeNull();
    // The host provider list is read once per listComments, not per comment.
    expect(harness.sdk.callsTo("providers.list")).toHaveLength(1);
    await harness.dispose();
  });

  it("lists bb workspace projects as id/name options", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        projects: {
          list: async () => [
            { id: "proj_personal", name: "Personal", extra: "dropped" },
            { id: "proj_bb", name: "bb" },
          ],
        },
      },
    });
    registerTasksApi(bb, createStore(bb));

    const result = tasksRpcContract.listBbProjects.output.parse(
      await harness.callRpc("listBbProjects", null),
    );
    expect(result.bbProjects).toEqual([
      { id: "proj_personal", name: "Personal" },
      { id: "proj_bb", name: "bb" },
    ]);
    expect(harness.sdk.callsTo("projects.list")).toEqual([
      [{ includePersonal: true }],
    ]);
    await harness.dispose();
  });

  it("lists machines as id/name options from the BB SDK", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        hosts: {
          list: async () => [
            {
              id: "host_primary",
              name: "Sawyer Air",
              status: "connected",
            },
            {
              id: "host_remote",
              name: "Build box",
              status: "disconnected",
            },
          ],
        },
      },
    });
    registerTasksApi(bb, createStore(bb));

    await expect(harness.callRpc("listMachines", {})).resolves.toEqual({
      machines: [
        { id: "host_primary", name: "Sawyer Air" },
        { id: "host_remote", name: "Build box" },
      ],
    });
    expect(harness.sdk.callsTo("hosts.list")).toEqual([[]]);

    await harness.dispose();
  });

  it("searches threads and returns recent threads in updated order", async () => {
    const thread = (
      id: string,
      title: string | null,
      titleFallback: string | null,
      updatedAt: number,
      status: string,
    ) => ({ id, title, titleFallback, updatedAt, status });
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          search: async () => ({
            active: {
              results: [
                {
                  thread: thread("thr_old", "Old match", null, 10, "idle"),
                },
                {
                  thread: thread("thr_new", null, "New fallback", 30, "active"),
                },
              ],
            },
            archived: {
              results: [
                {
                  thread: thread(
                    "thr_middle",
                    "Middle match",
                    null,
                    20,
                    "error",
                  ),
                },
              ],
            },
          }),
          list: async () => [
            thread("thr_recent_old", "Recent old", null, 40, "idle"),
            thread("thr_recent_new", null, "Recent new", 50, "starting"),
          ],
        },
      },
    });
    registerTasksApi(bb, createStore(bb));

    await expect(
      harness.callRpc("searchThreads", { query: "match", limit: 2 }),
    ).resolves.toEqual({
      threads: [
        { id: "thr_new", title: "New fallback", status: "active" },
        { id: "thr_middle", title: "Middle match", status: "error" },
      ],
    });
    await expect(
      harness.callRpc("searchThreads", { query: "" }),
    ).resolves.toEqual({
      threads: [
        { id: "thr_recent_new", title: "Recent new", status: "starting" },
        { id: "thr_recent_old", title: "Recent old", status: "idle" },
      ],
    });
    expect(harness.sdk.callsTo("threads.search")).toEqual([
      [{ query: "match", limitPerGroup: "10" }],
    ]);
    expect(harness.sdk.callsTo("threads.list")).toEqual([[{ limit: 10 }]]);
    await harness.dispose();
  });

  it("does not send for notify=false or when no prior agent has replied", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { threads: { send: async () => undefined } },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Quiet comments",
      prefix: "QIT",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Avoid loops",
    });
    store.tasks.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_worker",
      presetName: "Default",
      title: "Worker",
      liveStatus: "working",
    });

    const quietResult = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "Record this without notifying.",
        notify: false,
      }),
    );
    const agentComment = await createComment(bb, store, {
      taskId: task.id,
      kind: "agent",
      authorName: "Worker",
      presetName: null,
      threadId: "thr_worker",
      body: "Reporting progress.",
      notify: true,
    });

    expect(quietResult.comment.notifiedCount).toBe(0);
    expect(agentComment.notifiedCount).toBe(0);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
    expect(harness.realtimeSignals.slice(-2)).toEqual([
      {
        channel: "comments:changed",
        payload: { taskId: task.id, notifiedCount: 0 },
      },
      {
        channel: "comments:changed",
        payload: { taskId: task.id, notifiedCount: 0 },
      },
    ]);
    await harness.dispose();
  });

  it("allows an empty comment body only with attachment intent", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Attachment comments",
      prefix: "ACM",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Attach without text",
    });

    await expect(
      harness.callRpc("createComment", {
        taskId: task.id,
        body: "",
        notify: false,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      harness.callRpc("createComment", {
        taskId: task.id,
        body: "",
        notify: false,
        allowEmptyBody: true,
      }),
    ).resolves.toEqual({
      comment: expect.objectContaining({
        taskId: task.id,
        body: "",
        notifiedCount: 0,
      }),
    });

    await harness.dispose();
  });

  it("keeps the comment when delivery to the latest responder fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({ id: threadId, status: "active" }),
          send: async (input) => {
            if (input.threadId === "thr_failing") {
              throw new Error("active turn finished");
            }
          },
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Partial delivery",
      prefix: "PRT",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Keep comments durable",
    });
    for (const threadId of ["thr_success", "thr_failing"]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Earlier agent",
      threadId: "thr_success",
      body: "Earlier reply",
    });
    store.tasks.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Latest agent",
      threadId: "thr_failing",
      body: "Latest reply",
    });

    const result = tasksRpcContract.createComment.output.parse(
      await harness.callRpc("createComment", {
        taskId: task.id,
        body: "This comment must survive delivery failures.",
        notify: true,
      }),
    );

    expect(result.comment.notifiedCount).toBe(0);
    expect(store.tasks.getComment(result.comment.id)).toMatchObject({
      body: "This comment must survive delivery failures.",
      notifiedCount: 0,
    });
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.logEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: expect.stringContaining("thr_failing"),
        }),
      ]),
    );
    await harness.dispose();
  });

  it("removes task and comment attachment blobs when deleting a task", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttachments(bb, store.tasks);
    const project = store.tasks.createProject({
      name: "Cleanup",
      prefix: "CLN",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Delete blobs",
    });
    const comment = store.tasks.createComment({
      taskId: task.id,
      kind: "user",
      authorName: "Sawyer",
      body: "Attached context",
    });

    try {
      const taskUpload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${task.id}&fileName=task.txt&mime=text%2Fplain`,
        { body: "task blob", headers: { "content-type": "text/plain" } },
      );
      const commentUpload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?commentId=${comment.id}&fileName=comment.txt&mime=text%2Fplain`,
        { body: "comment blob", headers: { "content-type": "text/plain" } },
      );
      const taskAttachmentId = (
        (await taskUpload.json()) as { attachmentId: string }
      ).attachmentId;
      const commentAttachmentId = (
        (await commentUpload.json()) as { attachmentId: string }
      ).attachmentId;
      const taskAttachment = store.tasks.getAttachment(taskAttachmentId);
      const commentAttachment = store.tasks.getAttachment(commentAttachmentId);
      if (!taskAttachment || !commentAttachment) {
        throw new Error("attachment rows were not created");
      }
      const database = bb.storage
        .database()
        .prepare<[], { name: string; file: string }>("PRAGMA database_list")
        .all()
        .find((entry) => entry.name === "main");
      if (!database) throw new Error("test database path is missing");
      const blobDirectories = [taskAttachment, commentAttachment].map(
        (attachment) =>
          dirname(join(dirname(database.file), attachment.blobPath)),
      );

      await expect(
        harness.callRpc("deleteTask", { taskId: task.id }),
      ).resolves.toEqual({ deleted: true });
      for (const blobDirectory of blobDirectories) {
        await expect(stat(blobDirectory)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await harness.dispose();
    }
  });

  it("removes attachment blobs when force-deleting a project", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttachments(bb, store.tasks);
    const project = store.tasks.createProject({
      name: "Project cleanup",
      prefix: "PRJ",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Delete project blobs",
    });

    try {
      const upload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${task.id}&fileName=project.txt&mime=text%2Fplain`,
        { body: "project blob", headers: { "content-type": "text/plain" } },
      );
      const attachmentId = ((await upload.json()) as { attachmentId: string })
        .attachmentId;
      const attachment = store.tasks.getAttachment(attachmentId);
      if (!attachment) throw new Error("attachment row was not created");
      const database = bb.storage
        .database()
        .prepare<[], { name: string; file: string }>("PRAGMA database_list")
        .all()
        .find((entry) => entry.name === "main");
      if (!database) throw new Error("test database path is missing");
      const blobDirectory = dirname(
        join(dirname(database.file), attachment.blobPath),
      );

      await expect(
        harness.callRpc("deleteProject", {
          projectId: project.id,
          force: true,
        }),
      ).resolves.toEqual({ ok: true, deleted: true });
      await expect(stat(blobDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("runs the project and task flow with comments, filtering, summary SQL, and invalidations", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);

    const projectResult = tasksRpcContract.createProject.output.parse(
      await harness.callRpc("createProject", {
        name: "Plugin",
        prefix: "PLUG",
        color: "blue",
      }),
    );
    const project = projectResult.project;
    const labelResult = tasksRpcContract.createLabel.output.parse(
      await harness.callRpc("createLabel", {
        projectId: project.id,
        name: "Backend",
        color: "green",
      }),
    );

    const createResult = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        projectId: project.id,
        title: "Ship domain API",
      }),
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) throw new Error(createResult.error.message);

    const updateResult = tasksRpcContract.updateTask.output.parse(
      await harness.callRpc("updateTask", {
        taskId: createResult.task.id,
        status: "in_review",
        priority: "high",
        dueDate: "2026-07-20",
        labelIds: [labelResult.label.id],
        authorName: "Sawyer",
      }),
    );
    expect(updateResult).toMatchObject({
      ok: true,
      task: { status: "in_review" },
    });
    expect(store.tasks.listComments(createResult.task.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          authorName: "Sawyer",
          body: "Status changed to In Review by Sawyer",
          notifiedCount: 0,
        }),
        expect.objectContaining({
          kind: "system",
          body: "Priority changed to High by Sawyer",
        }),
        expect.objectContaining({
          kind: "system",
          body: "Due date changed to 2026-07-20 by Sawyer",
        }),
        expect.objectContaining({
          kind: "system",
          body: "Labels changed to Backend by Sawyer",
        }),
      ]),
    );

    const moveResult = tasksRpcContract.boardMove.output.parse(
      await harness.callRpc("boardMove", {
        taskId: createResult.task.id,
        status: "done",
        authorName: "Sawyer",
      }),
    );
    expect(moveResult).toMatchObject({ ok: true, task: { status: "done" } });

    store.tasks.upsertTaskThread({
      taskId: createResult.task.id,
      threadId: "thr_worker",
      presetName: "Default",
      title: "Implement API",
      liveStatus: "working",
    });

    const listResult = tasksRpcContract.listTasks.output.parse(
      await harness.callRpc("listTasks", {
        projectId: project.id,
        statuses: ["done"],
      }),
    );
    expect(listResult.tasks).toEqual([
      expect.objectContaining({
        id: createResult.task.id,
        key: "PLUG-1",
        status: "done",
        labelIds: [labelResult.label.id],
      }),
    ]);

    const subtask = store.tasks.createTask({
      projectId: project.id,
      parentTaskId: createResult.task.id,
      title: "Nested implementation detail",
    });
    store.tasks.upsertTaskThread({
      taskId: subtask.id,
      threadId: "thr_subtask_worker",
      presetName: "Default",
      title: "Implement nested detail",
      liveStatus: "working",
    });
    store.tasks.createTask({
      projectId: project.id,
      title: "Open top-level follow-up",
      status: "todo",
    });
    store.tasks.createTask({
      projectId: project.id,
      title: "Canceled top-level follow-up",
      status: "canceled",
    });

    const openCount = tasksRpcContract.sidebarOpenTaskCount.output.parse(
      await harness.callRpc("sidebarOpenTaskCount", null),
    );
    expect(openCount).toEqual({ openTaskCount: 2 });

    const summary = tasksRpcContract.sidebarSummary.output.parse(
      await harness.callRpc("sidebarSummary", null),
    );
    expect(summary).toEqual({
      projects: [
        {
          projectId: project.id,
          taskCount: 3,
          activeAgentCount: 1,
        },
      ],
    });
    await expect(
      harness.callRpc("deleteProject", { projectId: project.id }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "project_not_empty",
        message:
          "A project must be empty before it can be deleted; pass force: true to delete its tasks",
      },
    });
    expect(harness.realtimeSignals).toEqual(
      expect.arrayContaining([
        {
          channel: "projects:changed",
          payload: { projectId: project.id },
        },
        {
          channel: "tasks:changed",
          payload: { taskId: createResult.task.id, projectId: project.id },
        },
        {
          channel: "comments:changed",
          payload: { taskId: createResult.task.id },
        },
      ]),
    );

    await expect(
      harness.callRpc("updateProject", {
        projectId: project.id,
        prefix: "NEW",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await harness.dispose();
  });

  it("resolves task keys case-insensitively and degrades bad keys to null", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Plugin",
      prefix: "PLUG",
      color: "blue",
    });
    const label = store.tasks.createLabel({
      projectId: project.id,
      name: "Backend",
      color: "green",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship task embeds",
    });
    store.tasks.addTaskLabel(task.id, label.id);

    const found = tasksRpcContract.getTaskByKey.output.parse(
      await harness.callRpc("getTaskByKey", { taskKey: task.key }),
    );
    expect(found.task).toMatchObject({
      id: task.id,
      key: task.key,
      labelIds: [label.id],
    });

    const caseInsensitive = tasksRpcContract.getTaskByKey.output.parse(
      await harness.callRpc("getTaskByKey", {
        taskKey: task.key.toLowerCase(),
      }),
    );
    expect(caseInsensitive.task?.id).toBe(task.id);

    // Unknown number, unknown prefix, and malformed keys all degrade to null
    // (the chat card's not-found state), never an RPC error.
    for (const taskKey of ["PLUG-999", "NOPE-1", "not a key", "PLUG-"]) {
      const missing = tasksRpcContract.getTaskByKey.output.parse(
        await harness.callRpc("getTaskByKey", { taskKey }),
      );
      expect(missing.task).toBeNull();
    }
  });

  it("returns a typed error when a task would exceed one sub-task level", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    registerTasksApi(bb, createStore(bb));

    const projectResult = tasksRpcContract.createProject.output.parse(
      await harness.callRpc("createProject", {
        name: "Depth",
        prefix: "DEP",
        color: "purple",
      }),
    );
    const parentResult = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        projectId: projectResult.project.id,
        title: "Parent",
      }),
    );
    if (!parentResult.ok) throw new Error(parentResult.error.message);
    const childResult = tasksRpcContract.createTask.output.parse(
      await harness.callRpc("createTask", {
        projectId: projectResult.project.id,
        title: "Child",
        parentTaskId: parentResult.task.id,
      }),
    );
    if (!childResult.ok) throw new Error(childResult.error.message);

    await expect(
      harness.callRpc("createTask", {
        projectId: projectResult.project.id,
        title: "Grandchild",
        parentTaskId: childResult.task.id,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "subtask_depth_exceeded",
        message: "Tasks support at most one level of sub-tasks",
      },
    });

    await harness.dispose();
  });

  it("allows builtin execution changes while refusing contract mutations", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const preset = store.tasks
      .listPresets()
      .find((candidate) => candidate.name === "implement");
    if (!preset) throw new Error("expected seeded implement preset");

    const executionUpdate = tasksRpcContract.updatePreset.output.parse(
      await harness.callRpc("updatePreset", {
        presetId: preset.id,
        modelId: "user-selected-model",
        name: preset.name,
        instructions: preset.instructions,
      }),
    );
    expect(executionUpdate).toEqual({
      preset: expect.objectContaining({
        id: preset.id,
        name: "implement",
        modelId: "user-selected-model",
        instructions: preset.instructions,
        builtin: true,
      }),
    });
    const signalsBeforeRefusal = harness.realtimeSignals.length;

    const instructionsAttempt = tasksRpcContract.updatePreset.output.parse(
      await harness.callRpc("updatePreset", {
        presetId: preset.id,
        instructions: "changed",
      }),
    );
    expect(instructionsAttempt).toEqual({
      ok: false,
      error: {
        code: "preset_builtin",
        message:
          'Preset "implement" ships with the plugin: its name and instructions cannot be edited, but every execution field can.',
      },
    });
    const nameAttempt = tasksRpcContract.updatePreset.output.parse(
      await harness.callRpc("updatePreset", {
        presetId: preset.id,
        name: "User preset",
      }),
    );
    expect(nameAttempt).toEqual({
      ok: false,
      error: {
        code: "preset_builtin",
        message:
          'Preset "implement" ships with the plugin: its name and instructions cannot be edited, but every execution field can.',
      },
    });
    const deleteAttempt = tasksRpcContract.deletePreset.output.parse(
      await harness.callRpc("deletePreset", { presetId: preset.id }),
    );
    expect(deleteAttempt).toEqual({
      ok: false,
      error: {
        code: "preset_builtin",
        message:
          'Preset "implement" ships with the plugin and cannot be deleted.',
      },
    });
    expect(harness.realtimeSignals).toHaveLength(signalsBeforeRefusal);
    expect(store.tasks.getPreset(preset.id)).toMatchObject({
      name: "implement",
      builtin: true,
    });

    const custom = store.tasks.createPreset({
      name: "Custom API preset",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: null,
      permissionMode: "accept-edits",
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
      instructions: "",
    });
    const updated = await harness.callRpc("updatePreset", {
      presetId: custom.id,
      instructions: "updated",
    });
    expect(updated.preset).toMatchObject({
      id: custom.id,
      instructions: "updated",
      builtin: false,
    });
    await expect(
      harness.callRpc("deletePreset", { presetId: custom.id }),
    ).resolves.toEqual({ deleted: true });
    expect(store.tasks.getPreset(custom.id)).toBeUndefined();

    const listed = await harness.callRpc("listPresets", null);
    expect(listed.presets).toEqual([
      expect.objectContaining({
        id: preset.id,
        name: "implement",
        builtin: true,
      }),
    ]);

    await harness.dispose();
  });

  it("resolves task pull requests from environment metadata, deduped by URL", async () => {
    const pullRequestsByEnvironment: Record<string, PullRequestLookup> = {
      env_shared: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 12,
          url: "https://github.com/acme/bb/pull/12",
          state: "open",
          updatedAt: "2026-07-15T10:00:00.000Z",
        }),
      },
      env_merged: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 9,
          title: "Older merged work",
          url: "https://github.com/acme/bb/pull/9",
          state: "merged",
          updatedAt: "2026-07-16T09:00:00.000Z",
        }),
      },
      env_no_pr: { outcome: "absent" },
    };
    const environmentByThread: Record<string, string | null> = {
      thr_writer00: "env_shared",
      thr_reviewer0: "env_shared",
      thr_merger000: "env_merged",
      thr_no_env000: null,
      thr_no_pr0000: "env_no_pr",
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => {
            if (threadId === "thr_deleted00") {
              throw new Error("thread_not_found");
            }
            return makeThreadResponse({
              id: threadId,
              environmentId: environmentByThread[threadId] ?? null,
            });
          },
        },
        environments: {
          pullRequest: async ({ environmentId }: { environmentId: string }) =>
            pullRequestsByEnvironment[environmentId]!,
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of [
      ...Object.keys(environmentByThread),
      "thr_deleted00",
    ]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await harness.callRpc("listTaskPullRequests", { taskId: task.id }),
    );

    // Same-millisecond attachments make relative thread order nondeterministic,
    // so compare threadIds as sets.
    expect(
      result.pullRequests.map((pullRequest) => ({
        ...pullRequest,
        threadIds: [...pullRequest.threadIds].sort(),
      })),
    ).toEqual([
      {
        url: "https://github.com/acme/bb/pull/9",
        number: 9,
        title: "Older merged work",
        state: "merged",
        updatedAt: "2026-07-16T09:00:00.000Z",
        threadIds: ["thr_merger000"],
      },
      {
        url: "https://github.com/acme/bb/pull/12",
        number: 12,
        title: "Fix the pill",
        state: "open",
        updatedAt: "2026-07-15T10:00:00.000Z",
        threadIds: ["thr_reviewer0", "thr_writer00"],
      },
    ]);
    expect(result.unavailableThreadIds).toEqual(["thr_deleted00"]);
    // One lookup per distinct environment: threads sharing env_shared reuse
    // a single grouped call.
    expect(
      harness.sdk
        .callsTo("environments.pullRequest")
        .map(([input]) => (input as { environmentId: string }).environmentId)
        .sort(),
    ).toEqual(["env_merged", "env_no_pr", "env_shared"]);

    await harness.dispose();
  });

  it("separates unavailable lookups (auth failure, crash) from genuine absence", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              environmentId:
                threadId === "thr_absent000"
                  ? "env_absent"
                  : threadId === "thr_crash0000"
                    ? "env_crash"
                    : "env_no_auth",
            }),
        },
        environments: {
          pullRequest: async ({
            environmentId,
          }: {
            environmentId: string;
          }): Promise<PullRequestLookup> => {
            if (environmentId === "env_absent") return { outcome: "absent" };
            if (environmentId === "env_crash") {
              throw new Error("host offline");
            }
            return {
              outcome: "unavailable",
              message: "gh pr view failed: authentication required",
            };
          },
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of [
      "thr_no_auth00",
      "thr_no_auth01",
      "thr_absent000",
      "thr_crash0000",
    ]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await harness.callRpc("listTaskPullRequests", { taskId: task.id }),
    );
    // The genuinely absent PR is quiet; only failed lookups are flagged, and
    // every thread of a failed environment is flagged.
    expect(result.pullRequests).toEqual([]);
    expect([...result.unavailableThreadIds].sort()).toEqual([
      "thr_crash0000",
      "thr_no_auth00",
      "thr_no_auth01",
    ]);

    await harness.dispose();
  });

  it("overlaps distinct environment lookups while deduplicating shared ones", async () => {
    const resolvers = new Map<string, (lookup: PullRequestLookup) => void>();
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              environmentId: threadId === "thr_beta00000" ? "env_b" : "env_a",
            }),
        },
        environments: {
          pullRequest: ({ environmentId }: { environmentId: string }) =>
            new Promise<PullRequestLookup>((resolve) => {
              resolvers.set(environmentId, resolve);
            }),
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    // Two threads share env_a; a third uses env_b.
    for (const threadId of [
      "thr_alpha0000",
      "thr_alpha0001",
      "thr_beta00000",
    ]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const resultPromise = harness.callRpc("listTaskPullRequests", {
      taskId: task.id,
    });
    // Both environment lookups must be in flight before either resolves —
    // serialized lookups would only ever have one pending resolver here.
    await vi.waitFor(() => {
      expect([...resolvers.keys()].sort()).toEqual(["env_a", "env_b"]);
    });
    expect(harness.sdk.callsTo("environments.pullRequest")).toHaveLength(2);

    resolvers.get("env_a")!({
      outcome: "available",
      pullRequest: makePullRequest({
        number: 21,
        url: "https://github.com/acme/bb/pull/21",
      }),
    });
    resolvers.get("env_b")!({ outcome: "absent" });

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await resultPromise,
    );
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({ number: 21 });
    expect([...result.pullRequests[0]!.threadIds].sort()).toEqual([
      "thr_alpha0000",
      "thr_alpha0001",
    ]);
    // Still exactly one lookup per distinct environment.
    expect(harness.sdk.callsTo("environments.pullRequest")).toHaveLength(2);

    await harness.dispose();
  });

  it("keeps the freshest payload when two environments share a PR URL", async () => {
    const lookupByEnvironment: Record<string, PullRequestLookup> = {
      env_stale: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 30,
          title: "Before merge",
          state: "open",
          url: "https://github.com/acme/bb/pull/30",
          updatedAt: "2026-07-15T08:00:00.000Z",
        }),
      },
      env_fresh: {
        outcome: "available",
        pullRequest: makePullRequest({
          number: 30,
          title: "After merge",
          state: "merged",
          url: "https://github.com/acme/bb/pull/30",
          updatedAt: "2026-07-16T12:00:00.000Z",
        }),
      },
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({
              id: threadId,
              environmentId:
                threadId === "thr_stale0000" ? "env_stale" : "env_fresh",
            }),
        },
        environments: {
          pullRequest: async ({ environmentId }: { environmentId: string }) =>
            lookupByEnvironment[environmentId]!,
        },
      },
    });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "PRs",
      prefix: "PR",
      color: "blue",
    });
    const task = store.tasks.createTask({
      projectId: project.id,
      title: "Ship it",
    });
    for (const threadId of ["thr_stale0000", "thr_fresh0000"]) {
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId,
        presetName: "Default",
        title: threadId,
        liveStatus: "working",
      });
    }

    const result = tasksRpcContract.listTaskPullRequests.output.parse(
      await harness.callRpc("listTaskPullRequests", { taskId: task.id }),
    );
    expect(
      result.pullRequests.map((pullRequest) => ({
        ...pullRequest,
        threadIds: [...pullRequest.threadIds].sort(),
      })),
    ).toEqual([
      {
        url: "https://github.com/acme/bb/pull/30",
        number: 30,
        title: "After merge",
        state: "merged",
        updatedAt: "2026-07-16T12:00:00.000Z",
        threadIds: ["thr_fresh0000", "thr_stale0000"],
      },
    ]);

    await harness.dispose();
  });

  describe("getReviewDiff", () => {
    function reviewMetadata(environmentId: string | null) {
      return {
        baseRef: "main",
        headSha: "pinned-head",
        environmentId,
        concerns: [
          {
            title: "First concern",
            why: "The first cited range explains the behavior",
            evidence: [],
            decisions: [],
            risks: "",
            hunks: [{ path: "src/first.ts", startLine: 4, endLine: 8 }],
          },
          {
            title: "Second concern",
            why: "The second cited range explains the consequence",
            evidence: [],
            decisions: [],
            risks: "",
            hunks: [
              { path: "src/first.ts", startLine: 20, endLine: 24 },
              { path: "src/second.ts", startLine: 3, endLine: 5 },
            ],
          },
        ],
      };
    }

    function addReview(
      store: ReturnType<typeof createStore>,
      taskId: string,
      options: { environmentId: string | null; sourceThreadId?: string },
    ) {
      return store.tasks.createTaskArtifact({
        taskId,
        kind: "review",
        title: "Narrative review",
        sourceThreadId: options.sourceThreadId,
        metadata: reviewMetadata(options.environmentId),
      });
    }

    function addTask(
      bb: Parameters<typeof createStore>[0],
      harness: ReturnType<typeof createFakePluginHost>["harness"],
    ) {
      const store = createStore(bb);
      registerTasksApi(bb, store);
      const project = store.tasks.createProject({
        name: "Review diffs",
        prefix: "RVD",
        color: "blue",
      });
      const task = store.tasks.createTask({
        projectId: project.id,
        title: "Review a change",
      });
      return { harness, store, task };
    }

    it("prefers metadata, then source-thread, then attached-thread environments", async () => {
      const metadataHost = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: async ({ threadId }: { threadId: string }) =>
              makeThreadResponse({
                id: threadId,
                environmentId: "env_source",
              }),
          },
          environments: {
            diffPatch: async () => ({ outcome: "available", patches: [] }),
          },
        },
      });
      const metadata = addTask(metadataHost.bb, metadataHost.harness);
      const metadataArtifact = addReview(metadata.store, metadata.task.id, {
        environmentId: "env_metadata",
        sourceThreadId: "thr_source00",
      });
      metadata.store.tasks.upsertTaskThread({
        taskId: metadata.task.id,
        threadId: "thr_attached00",
        presetName: "Default",
        title: "Attached",
        liveStatus: "working",
      });
      const metadataResult = tasksRpcContract.getReviewDiff.output.parse(
        await metadata.harness.callRpc("getReviewDiff", {
          artifactId: metadataArtifact.id,
        }),
      );
      expect(metadataResult).toMatchObject({
        outcome: "available",
        environmentId: "env_metadata",
      });
      expect(
        metadata.harness.sdk.callsTo("environments.diffPatch"),
      ).toEqual([
        [
          {
            environmentId: "env_metadata",
            target: { type: "branch_committed", mergeBaseBranch: "main" },
            paths: ["src/first.ts", "src/second.ts"],
          },
        ],
      ]);
      await metadata.harness.dispose();

      const sourceHost = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: async ({ threadId }: { threadId: string }) =>
              makeThreadResponse({
                id: threadId,
                environmentId:
                  threadId === "thr_source01" ? "env_source" : "env_attached",
              }),
          },
          environments: {
            diffPatch: async () => ({ outcome: "available", patches: [] }),
          },
        },
      });
      const source = addTask(sourceHost.bb, sourceHost.harness);
      const sourceArtifact = addReview(source.store, source.task.id, {
        environmentId: null,
        sourceThreadId: "thr_source01",
      });
      source.store.tasks.upsertTaskThread({
        taskId: source.task.id,
        threadId: "thr_attached01",
        presetName: "Default",
        title: "Attached",
        liveStatus: "working",
      });
      const sourceResult = tasksRpcContract.getReviewDiff.output.parse(
        await source.harness.callRpc("getReviewDiff", {
          artifactId: sourceArtifact.id,
        }),
      );
      expect(sourceResult).toMatchObject({
        outcome: "available",
        environmentId: "env_source",
      });
      expect(source.harness.sdk.callsTo("threads.get")).toEqual([
        [{ threadId: "thr_source01" }],
      ]);
      await source.harness.dispose();

      const attachedHost = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: async ({ threadId }: { threadId: string }) =>
              makeThreadResponse({
                id: threadId,
                environmentId:
                  threadId === "thr_attached02" ? "env_attached" : null,
              }),
          },
          environments: {
            diffPatch: async () => ({ outcome: "available", patches: [] }),
          },
        },
      });
      const attached = addTask(attachedHost.bb, attachedHost.harness);
      const attachedArtifact = addReview(attached.store, attached.task.id, {
        environmentId: null,
      });
      for (const threadId of ["thr_empty02", "thr_attached02", "thr_later02"]) {
        attached.store.tasks.upsertTaskThread({
          taskId: attached.task.id,
          threadId,
          presetName: "Default",
          title: "Attached",
          liveStatus: "working",
        });
      }
      const attachedResult = tasksRpcContract.getReviewDiff.output.parse(
        await attached.harness.callRpc("getReviewDiff", {
          artifactId: attachedArtifact.id,
        }),
      );
      expect(attachedResult).toMatchObject({
        outcome: "available",
        environmentId: "env_attached",
      });
      await attached.harness.dispose();
    });

    it("returns an empty available document without requesting a diff for zero concerns", async () => {
      const diffPatch = vi.fn(async () => ({ outcome: "available", patches: [] }));
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          environments: {
            diffPatch,
            status: async () => ({
              outcome: "available",
              workspace: {
                checkout: { kind: "branch", headSha: "current-head" },
              },
            }),
          },
        },
      });
      const { store, task } = addTask(bb, harness);
      const artifact = store.tasks.createTaskArtifact({
        taskId: task.id,
        kind: "review",
        title: "Clean review",
        metadata: {
          ...reviewMetadata("env_empty"),
          concerns: [],
        },
      });

      const result = tasksRpcContract.getReviewDiff.output.parse(
        await harness.callRpc("getReviewDiff", { artifactId: artifact.id }),
      );

      expect(result).toEqual({
        outcome: "available",
        baseRef: "main",
        pinnedHeadSha: "pinned-head",
        currentHeadSha: "current-head",
        environmentId: "env_empty",
        files: [],
      });
      expect(diffPatch).not.toHaveBeenCalled();
      await harness.dispose();
    });

    it("batches more than 50 cited paths and merges the patches in request order", async () => {
      const paths = Array.from({ length: 51 }, (_, index) =>
        `src/file-${index + 1}.ts`,
      );
      const diffPatch = vi.fn(
        async ({ paths: requestedPaths }: { paths: string[] }) => ({
          outcome: "available" as const,
          patches: requestedPaths.map((path) => ({
            path,
            patch: `patch for ${path}`,
            truncated: false,
          })),
        }),
      );
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: { environments: { diffPatch } },
      });
      const { store, task } = addTask(bb, harness);
      const artifact = store.tasks.createTaskArtifact({
        taskId: task.id,
        kind: "review",
        title: "Large review",
        metadata: {
          baseRef: "main",
          headSha: "pinned-head",
          environmentId: "env_many",
          concerns: paths.map((path, index) => ({
            title: `Concern ${index + 1}`,
            why: "The cited range explains the behavior",
            evidence: [],
            decisions: [],
            risks: "",
            hunks: [{ path, startLine: 1, endLine: 1 }],
          })),
        },
      });

      const result = tasksRpcContract.getReviewDiff.output.parse(
        await harness.callRpc("getReviewDiff", { artifactId: artifact.id }),
      );

      expect(result).toEqual({
        outcome: "available",
        baseRef: "main",
        pinnedHeadSha: "pinned-head",
        currentHeadSha: null,
        environmentId: "env_many",
        files: paths.map((path) => ({
          path,
          patch: `patch for ${path}`,
          truncated: false,
        })),
      });
      expect(
        harness
          .sdk
          .callsTo("environments.diffPatch")
          .map(([input]) => (input as { paths: string[] }).paths),
      ).toEqual([paths.slice(0, 50), paths.slice(50)]);
      await harness.dispose();
    });

    it("resolves attached threads concurrently while selecting the first environment in task order", async () => {
      const threadResolvers = new Map<
        string,
        (environmentId: string | null) => void
      >();
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: ({ threadId }: { threadId: string }) =>
              new Promise((resolve) => {
                threadResolvers.set(threadId, (environmentId) =>
                  resolve(makeThreadResponse({ id: threadId, environmentId })),
                );
              }),
          },
          environments: {
            diffPatch: async () => ({ outcome: "available", patches: [] }),
          },
        },
      });
      const { store, task } = addTask(bb, harness);
      const artifact = addReview(store, task.id, { environmentId: null });
      for (const threadId of ["thr_first03", "thr_second03", "thr_none03"]) {
        store.tasks.upsertTaskThread({
          taskId: task.id,
          threadId,
          presetName: "Default",
          title: "Attached",
          liveStatus: "working",
        });
      }
      const taskThreadOrder = store.tasks
        .listTaskThreads(task.id)
        .map((taskThread) => taskThread.threadId);
      const [firstThreadId, secondThreadId, lastThreadId] = taskThreadOrder;
      expect(firstThreadId).toBeDefined();
      expect(secondThreadId).toBeDefined();
      expect(lastThreadId).toBeDefined();

      const resultPromise = harness.callRpc("getReviewDiff", {
        artifactId: artifact.id,
      });
      await vi.waitFor(() => {
        expect(threadResolvers.size).toBe(3);
      });
      threadResolvers.get(secondThreadId!)!("env_second");
      threadResolvers.get(lastThreadId!)!(null);
      threadResolvers.get(firstThreadId!)!("env_first");

      const result = tasksRpcContract.getReviewDiff.output.parse(
        await resultPromise,
      );

      expect(result).toMatchObject({
        outcome: "available",
        environmentId: "env_first",
      });
      expect(harness.sdk.callsTo("threads.get")).toHaveLength(3);
      await harness.dispose();
    });

    it.each([
      ["not_a_review", "not_a_review"],
      ["artifact_not_found", "artifact_not_found"],
      ["no_environment", "no_environment"],
    ] as const)("returns the %s reason", async (label, reason) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
      const { store, task } = addTask(bb, harness);
      let artifactId: string;
      if (reason === "not_a_review") {
        artifactId = store.tasks.createTaskArtifact({
          taskId: task.id,
          kind: "evidence",
          title: "Evidence",
          metadata: {
            command: "npm test",
            exitCode: 0,
            evidenceKind: "unit",
          },
        }).id;
      } else if (reason === "artifact_not_found") {
        const artifact = addReview(store, task.id, { environmentId: null });
        store.tasks.deleteTaskArtifact(artifact.id);
        artifactId = artifact.id;
      } else {
        artifactId = addReview(store, task.id, { environmentId: null }).id;
      }

      const result = tasksRpcContract.getReviewDiff.output.parse(
        await harness.callRpc("getReviewDiff", { artifactId }),
      );
      expect(result).toMatchObject({ outcome: "unavailable", reason });
      await harness.dispose();
    });

    it.each([
      ["not_applicable", "non-git workspace"],
      ["unavailable", "permission denied"],
      ["throws", "host disconnected"],
    ] as const)("maps a diff %s to diff_unavailable with its message", async (
      outcome,
      message,
    ) => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          environments: {
            diffPatch: async () => {
              if (outcome === "throws") throw new Error(message);
              if (outcome === "not_applicable") {
                return {
                  outcome,
                  reason: "non_git_environment",
                  message,
                };
              }
              return { outcome, failure: { message } };
            },
          },
        },
      });
      const { store, task } = addTask(bb, harness);
      const artifact = addReview(store, task.id, { environmentId: "env_diff" });

      const result = tasksRpcContract.getReviewDiff.output.parse(
        await harness.callRpc("getReviewDiff", { artifactId: artifact.id }),
      );
      expect(result).toEqual({
        outcome: "unavailable",
        reason: "diff_unavailable",
        message,
      });
      await harness.dispose();
    });

    it("returns patches when status is unavailable and leaves the current head unknown", async () => {
      const patch = "@@ -1 +1 @@\n-old\n+new\n";
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          environments: {
            diffPatch: async () => ({
              outcome: "available",
              patches: [{ path: "src/first.ts", patch, truncated: false }],
            }),
            status: async () => ({
              outcome: "unavailable",
              failure: { message: "status unavailable" },
            }),
          },
        },
      });
      const { store, task } = addTask(bb, harness);
      const artifact = addReview(store, task.id, { environmentId: "env_status" });

      const result = tasksRpcContract.getReviewDiff.output.parse(
        await harness.callRpc("getReviewDiff", { artifactId: artifact.id }),
      );
      expect(result).toEqual({
        outcome: "available",
        baseRef: "main",
        pinnedHeadSha: "pinned-head",
        currentHeadSha: null,
        environmentId: "env_status",
        files: [{ path: "src/first.ts", patch, truncated: false }],
      });
      await harness.dispose();
    });
  });

  it("exposes blocker relations, list-row derivation, and API enforcement", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Local project",
      prefix: "LOC",
      color: "blue",
    });
    const otherProject = store.tasks.createProject({
      name: "External project",
      prefix: "EXT",
      color: "green",
    });
    const blocker = store.tasks.createTask({
      projectId: otherProject.id,
      title: "External prerequisite",
      status: "todo",
    });
    const blocked = store.tasks.createTask({
      projectId: project.id,
      title: "Local dependent",
    });
    const add = tasksRpcContract.addTaskBlocker.output.parse(
      await harness.callRpc("addTaskBlocker", {
        blockerTaskId: blocker.id,
        blockedTaskId: blocked.id,
      }),
    );
    expect(add).toEqual({
      ok: true,
      added: true,
      relation: {
        blockerTaskId: blocker.id,
        blockedTaskId: blocked.id,
      },
    });

    const details = tasksRpcContract.listTaskBlockers.output.parse(
      await harness.callRpc("listTaskBlockers", { taskId: blocked.id }),
    );
    expect(details).toEqual({
      blockers: [
        {
          id: blocker.id,
          key: blocker.key,
          title: blocker.title,
          status: "todo",
          projectId: otherProject.id,
        },
      ],
      unresolvedCount: 1,
    });
    expect(
      tasksRpcContract.listTaskBlocking.output.parse(
        await harness.callRpc("listTaskBlocking", { taskId: blocker.id }),
      ),
    ).toEqual({
      blocking: [
        expect.objectContaining({ id: blocked.id, projectId: project.id }),
      ],
    });
    const list = tasksRpcContract.listTasks.output.parse(
      await harness.callRpc("listTasks", { projectId: project.id }),
    );
    expect(list.tasks).toEqual([
      expect.objectContaining({
        id: blocked.id,
        blocked: true,
        unresolvedBlockerCount: 1,
      }),
    ]);

    const update = tasksRpcContract.updateTask.output.parse(
      await harness.callRpc("updateTask", {
        taskId: blocked.id,
        status: "in_progress",
      }),
    );
    expect(update).toEqual({
      ok: false,
      error: {
        code: "task_blocked",
        message: expect.stringContaining(`${blocker.key} (${blocker.title})`),
      },
    });
    const move = tasksRpcContract.boardMove.output.parse(
      await harness.callRpc("boardMove", {
        taskId: blocked.id,
        status: "in_progress",
      }),
    );
    expect(move).toEqual({
      ok: false,
      error: {
        code: "task_blocked",
        message: expect.stringContaining(blocker.key),
      },
    });
    expect(store.tasks.getTask(blocked.id)?.status).toBe("backlog");

    const completed = tasksRpcContract.updateTask.output.parse(
      await harness.callRpc("updateTask", {
        taskId: blocked.id,
        status: "done",
      }),
    );
    expect(completed).toMatchObject({ ok: true, task: { status: "done" } });

    harness.realtimeSignals.length = 0;
    const resolved = tasksRpcContract.updateTask.output.parse(
      await harness.callRpc("updateTask", {
        taskId: blocker.id,
        status: "done",
      }),
    );
    expect(resolved).toMatchObject({ ok: true, task: { status: "done" } });
    expect(store.tasks.getTask(blocked.id)).toMatchObject({
      blocked: false,
      unresolvedBlockerCount: 0,
    });
    expect(harness.realtimeSignals).toEqual(
      expect.arrayContaining([
        {
          channel: "tasks:changed",
          payload: { taskId: blocker.id, projectId: otherProject.id },
        },
        {
          channel: "tasks:changed",
          payload: { taskId: blocked.id, projectId: project.id },
        },
      ]),
    );

    const removed = tasksRpcContract.removeTaskBlocker.output.parse(
      await harness.callRpc("removeTaskBlocker", {
        blockerTaskId: blocker.id,
        blockedTaskId: blocked.id,
      }),
    );
    expect(removed).toEqual({ removed: true });
    expect(
      tasksRpcContract.listTaskBlockers.output.parse(
        await harness.callRpc("listTaskBlockers", { taskId: blocked.id }),
      ),
    ).toEqual({ blockers: [], unresolvedCount: 0 });

    await harness.dispose();
  });

  describe("review feedback rounds", () => {
    function addReview(
      store: ReturnType<typeof createStore>,
      taskId: string,
      sourceThreadId?: string,
    ) {
      return store.tasks.createTaskArtifact({
        taskId,
        kind: "review",
        title: "Narrative review",
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
        metadata: {
          baseRef: "main",
          headSha: "head-123",
          environmentId: null,
          concerns: [],
        },
      });
    }

    function addTask(bb: Parameters<typeof createStore>[0]) {
      const store = createStore(bb);
      registerTasksApi(bb, store);
      const project = store.tasks.createProject({
        name: "Review rounds",
        prefix: "RND",
        color: "blue",
      });
      const task = store.tasks.createTask({
        projectId: project.id,
        title: "Close the review loop",
      });
      return { store, project, task };
    }

    it("round-trips comments, summary, counts, and an in-place body edit", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
      const { store, task } = addTask(bb);
      const review = addReview(store, task.id);

      try {
        await expect(
          harness.callRpc("listReviewDrafts", {
            reviewArtifactId: review.id,
          }),
        ).resolves.toEqual({ comments: [], summary: "" });

        const first = tasksRpcContract.saveReviewDraftComment.output.parse(
          await harness.callRpc("saveReviewDraftComment", {
            reviewArtifactId: review.id,
            anchor: {
              anchor: "lines",
              path: "src/save.ts",
              side: "additions",
              startLine: 12,
              endLine: 13,
              quotedLines: ["+  await save(input);", "+  return result;"],
            },
            body: "The result is returned before the write is durable.",
          }),
        );
        const edited = tasksRpcContract.saveReviewDraftComment.output.parse(
          await harness.callRpc("saveReviewDraftComment", {
            id: first.comment.id,
            reviewArtifactId: review.id,
            anchor: first.comment.anchor,
            body: "The result can escape before the write is durable.",
          }),
        );
        expect(edited.comment).toMatchObject({
          id: first.comment.id,
          createdAt: first.comment.createdAt,
          anchor: first.comment.anchor,
          body: "The result can escape before the write is durable.",
        });

        const file = tasksRpcContract.saveReviewDraftComment.output.parse(
          await harness.callRpc("saveReviewDraftComment", {
            reviewArtifactId: review.id,
            anchor: { anchor: "file", path: "src/telemetry.ts" },
            body: "Please cover retries.",
          }),
        );
        await harness.callRpc("saveReviewDraftSummary", {
          reviewArtifactId: review.id,
          body: "The retry path needs one more test.",
        });

        const listed = tasksRpcContract.listReviewDrafts.output.parse(
          await harness.callRpc("listReviewDrafts", {
            reviewArtifactId: review.id,
          }),
        );
        expect(listed).toMatchObject({
          summary: "The retry path needs one more test.",
          comments: [edited.comment, file.comment],
        });
        expect(
          tasksRpcContract.countReviewDrafts.output.parse(
            await harness.callRpc("countReviewDrafts", { taskId: task.id }),
          ),
        ).toEqual({ counts: [{ reviewArtifactId: review.id, count: 2 }] });

        expect(
          await harness.callRpc("deleteReviewDraftComment", {
            id: first.comment.id,
          }),
        ).toEqual({ deleted: true });
        expect(
          tasksRpcContract.countReviewDrafts.output.parse(
            await harness.callRpc("countReviewDrafts", { taskId: task.id }),
          ),
        ).toEqual({ counts: [{ reviewArtifactId: review.id, count: 1 }] });
      } finally {
        await harness.dispose();
      }
    });

    it("writes the feedback artifact and clears drafts on submit", async () => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: { threads: { send: async () => undefined } },
      });
      const { store, task } = addTask(bb);
      const review = addReview(store, task.id);
      const targetThreadId = "thr_existing_round";
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: targetThreadId,
        presetName: "Attached",
        title: "Existing worker",
        liveStatus: "working",
      });

      try {
        await harness.callRpc("saveReviewDraftComment", {
          reviewArtifactId: review.id,
          anchor: { anchor: "file", path: "src/save.ts" },
          body: "The write needs a transaction.",
        });
        await harness.callRpc("saveReviewDraftSummary", {
          reviewArtifactId: review.id,
          body: "Please preserve the write ordering.",
        });

        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "comment",
            target: { kind: "existing", threadId: targetThreadId },
          }),
        );
        expect(result).toMatchObject({
          outcome: "submitted",
          threadId: targetThreadId,
        });
        if (result.outcome !== "submitted") throw new Error(result.message);

        expect(store.tasks.getTaskArtifact(result.artifactId)).toMatchObject({
          kind: "review_feedback",
          metadata: {
            reviewArtifactId: review.id,
            verdict: "comment",
            summary: "Please preserve the write ordering.",
            headSha: "head-123",
            targetThreadId,
            comments: [
              {
                anchor: "file",
                path: "src/save.ts",
                body: "The write needs a transaction.",
              },
            ],
          },
        });
        await expect(
          harness.callRpc("listReviewDrafts", {
            reviewArtifactId: review.id,
          }),
        ).resolves.toEqual({ comments: [], summary: "" });
      } finally {
        await harness.dispose();
      }
    });

    it("records approval without sending a message", async () => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: { threads: { send: async () => undefined } },
      });
      const { store, task } = addTask(bb);
      const review = addReview(store, task.id);

      try {
        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "approve",
          }),
        );
        expect(result).toMatchObject({ outcome: "submitted", threadId: null });
        expect(harness.sdk.callsTo("threads.send")).toEqual([]);
        if (result.outcome !== "submitted") throw new Error(result.message);
        expect(store.tasks.getTaskArtifact(result.artifactId)).toMatchObject({
          kind: "review_feedback",
          metadata: { verdict: "approve", targetThreadId: null },
        });
      } finally {
        await harness.dispose();
      }
    });

    it("sends request changes with quoted lines and the next-round instruction", async () => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: { threads: { send: async () => undefined } },
      });
      const { store, task } = addTask(bb);
      const review = addReview(store, task.id);
      const targetThreadId = "thr_request_changes";
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: targetThreadId,
        presetName: "Attached",
        title: "Worker",
        liveStatus: "working",
      });

      try {
        await harness.callRpc("saveReviewDraftComment", {
          reviewArtifactId: review.id,
          anchor: {
            anchor: "lines",
            path: "src/save.ts",
            side: "deletions",
            startLine: 7,
            endLine: 8,
            quotedLines: ["-  return cached;", "-}"],
          },
          body: "This bypasses the fresh value.",
        });
        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "request_changes",
            target: { kind: "existing", threadId: targetThreadId },
          }),
        );
        expect(result).toMatchObject({
          outcome: "submitted",
          threadId: targetThreadId,
        });

        expect(harness.sdk.callsTo("threads.send")).toEqual([
          [
            expect.objectContaining({
              threadId: targetThreadId,
              input: [
                expect.objectContaining({
                text: expect.stringContaining(
                    "-  return cached;\n-}\n```\n\nThis bypasses the fresh value.",
                  ),
                }),
              ],
            }),
          ],
        ]);
        const [[sendInput]] = harness.sdk.callsTo("threads.send") as [
          [{ input: [{ text: string }] }],
        ];
        expect(sendInput.input[0]?.text).toContain(
          "write a fresh narrative review artifact on task RND-1",
        );
      } finally {
        await harness.dispose();
      }
    });

    it("keeps the recorded artifact when delivery fails", async () => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            send: async () => {
              throw new Error("worker is unavailable");
            },
          },
        },
      });
      const { store, task } = addTask(bb);
      const review = addReview(store, task.id);
      const targetThreadId = "thr_failed_delivery";
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: targetThreadId,
        presetName: "Attached",
        title: "Worker",
        liveStatus: "working",
      });

      try {
        await harness.callRpc("saveReviewDraftComment", {
          reviewArtifactId: review.id,
          anchor: { anchor: "file", path: "src/save.ts" },
          body: "Keep this review record even if delivery fails.",
        });
        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "comment",
            target: { kind: "existing", threadId: targetThreadId },
          }),
        );
        expect(result).toEqual({
          outcome: "failed",
          reason: "send_failed",
          message: expect.stringContaining("recorded but not delivered"),
        });
        expect(store.tasks.listTaskArtifacts(task.id)).toEqual([
          expect.objectContaining({ kind: "review" }),
          expect.objectContaining({
            kind: "review_feedback",
            metadata: expect.objectContaining({ targetThreadId }),
          }),
        ]);
        await expect(
          harness.callRpc("listReviewDrafts", {
            reviewArtifactId: review.id,
          }),
        ).resolves.toEqual({ comments: [], summary: "" });
      } finally {
        await harness.dispose();
      }
    });

    it("records a non-approval but reports no target when none is selected", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
      const { store, task } = addTask(bb);
      const review = addReview(store, task.id);

      try {
        await harness.callRpc("saveReviewDraftComment", {
          reviewArtifactId: review.id,
          anchor: { anchor: "file", path: "src/save.ts" },
          body: "There is a concern, but no worker is selected.",
        });
        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "comment",
          }),
        );
        expect(result).toEqual({
          outcome: "failed",
          reason: "no_target_thread",
          message: expect.stringContaining("recorded"),
        });
        expect(harness.sdk.callsTo("threads.send")).toEqual([]);
        expect(store.tasks.listTaskArtifacts(task.id)).toEqual([
          expect.objectContaining({ kind: "review" }),
          expect.objectContaining({
            kind: "review_feedback",
            metadata: expect.objectContaining({ targetThreadId: null }),
          }),
        ]);
      } finally {
        await harness.dispose();
      }
    });

    it("records a round but reports spawn failure when the reviewing thread has no environment", async () => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: async () =>
              makeThreadResponse({
                id: "thr_reviewing_no_env",
                environmentId: null,
              }),
            spawn: async () => ({ id: "thr_never" }),
          },
        },
      });
      const { store, task } = addTask(bb);
      const preset = store.tasks.createPreset({
        name: "Review worker",
        providerId: "claude-code",
        modelId: "claude-sonnet-5",
        reasoningLevel: "high",
        serviceTier: null,
        permissionMode: "full",
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
        instructions: "",
      });
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: "thr_reviewing_no_env",
        presetName: preset.name,
        title: "Reviewing",
        liveStatus: "working",
      });
      const review = addReview(store, task.id, "thr_reviewing_no_env");

      try {
        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "comment",
            target: { kind: "new" },
          }),
        );
        expect(result).toEqual({
          outcome: "failed",
          reason: "spawn_failed",
          message: expect.stringContaining(
            "reviewing thread is gone or has no environment",
          ),
        });
        expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);
        expect(store.tasks.listTaskArtifacts(task.id)).toEqual([
          expect.objectContaining({ kind: "review" }),
          expect.objectContaining({
            kind: "review_feedback",
            metadata: expect.objectContaining({ targetThreadId: null }),
          }),
        ]);
      } finally {
        await harness.dispose();
      }
    });

    it("spawns new feedback threads from the reviewing thread's preset and environment", async () => {
      const { bb, harness } = createFakePluginHost({
        pluginId: "tasks",
        sdk: {
          threads: {
            get: async () =>
              makeThreadResponse({
                id: "thr_reviewing",
                projectId: "proj_review",
                environmentId: "env_review",
              }),
            spawn: async () => ({ id: "thr_feedback" }),
            send: async () => undefined,
          },
        },
      });
      const { store, task } = addTask(bb);
      const preset = store.tasks.createPreset({
        name: "Review worker",
        providerId: "claude-code",
        modelId: "claude-sonnet-5",
        reasoningLevel: "high",
        serviceTier: "fast",
        permissionMode: "full",
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
        instructions: "",
      });
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: "thr_reviewing",
        presetName: preset.name,
        title: "Reviewing",
        liveStatus: "working",
      });
      const review = addReview(store, task.id, "thr_reviewing");

      try {
        const result = tasksRpcContract.submitReviewFeedback.output.parse(
          await harness.callRpc("submitReviewFeedback", {
            reviewArtifactId: review.id,
            verdict: "comment",
            target: { kind: "new" },
          }),
        );
        expect(result).toMatchObject({
          outcome: "submitted",
          threadId: "thr_feedback",
        });
        expect(harness.sdk.callsTo("threads.spawn")).toEqual([
          [
            expect.objectContaining({
              projectId: "proj_review",
              environment: { type: "reuse", environmentId: "env_review" },
              providerId: "claude-code",
              model: "claude-sonnet-5",
              reasoningLevel: "high",
              serviceTier: "fast",
              permissionMode: "full",
            }),
          ],
        ]);
        expect(
          store.tasks.getTaskThreadByThreadId(task.id, "thr_feedback"),
        ).toMatchObject({
          presetName: preset.name,
          liveStatus: "starting",
        });
        expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
      } finally {
        await harness.dispose();
      }
    });
  });

  describe("task artifacts", () => {
    async function setUpArtifacts() {
      const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
      const store = createStore(bb);
      registerAttachments(bb, store.tasks);
      registerTasksApi(bb, store);
      const project = store.tasks.createProject({
        name: "Artifacts",
        prefix: "ART",
        color: "blue",
      });
      const task = store.tasks.createTask({
        projectId: project.id,
        title: "Carry a record",
      });
      return { bb, harness, store, project, task };
    }

    /** One realistic metadata object per kind; `citedId` must be a real ULID. */
    function validMetadata(citedId: string) {
      return {
        approved_plan: { approvedBy: "Roger", approvedAt: "2026-08-30" },
        implementation_plan: { approvedBy: "Roger", approvedAt: "2026-08-29" },
        decision: {
          discovery: "The store already validates attachment ownership",
          decision: "Translate it at the RPC boundary",
          why: "Callers need a typed outcome, not a thrown error",
          impact: "One more domain error code",
        },
        evidence: {
          command: "npm test",
          exitCode: 0,
          evidenceKind: "unit" as const,
        },
        review: {
          baseRef: "main",
          headSha: "0f2c19a",
          environmentId: "env_amhbcapb7g",
          concerns: [
            {
              title: "Metadata is unvalidated below the boundary",
              why: "Storage only knows it is a JSON object",
              evidence: [citedId],
              decisions: [citedId],
              risks: "",
              hunks: [{ path: "api/index.ts", startLine: 3, endLine: 9 }],
            },
          ],
        },
        review_result: {
          verdict: "mixed" as const,
          findingCounts: { Standards: 2, Spec: 0 },
        },
        review_feedback: {
          reviewArtifactId: citedId,
          verdict: "comment" as const,
          summary: "The feedback is ready for the worker.",
          comments: [
            {
              anchor: "file" as const,
              path: "api/index.ts",
              body: "Keep this branch covered.",
            },
          ],
          headSha: "0f2c19a",
          targetThreadId: null,
        },
      };
    }

    it("accepts and round-trips valid metadata for every kind", async () => {
      const { harness, task } = await setUpArtifacts();
      const seed = tasksRpcContract.createArtifact.output.parse(
        await harness.callRpc("createArtifact", {
          taskId: task.id,
          kind: "decision",
          title: "Seed decision",
          metadata: validMetadata(task.id).decision,
        }),
      );
      if (!seed.ok) throw new Error("seed artifact was rejected");
      const metadata = validMetadata(seed.artifact.id);

      for (const kind of TASK_ARTIFACT_KINDS) {
        const result = tasksRpcContract.createArtifact.output.parse(
          await harness.callRpc("createArtifact", {
            taskId: task.id,
            kind,
            title: `A ${kind}`,
            metadata: metadata[kind],
          }),
        );
        expect(result).toMatchObject({
          ok: true,
          artifact: { kind, title: `A ${kind}`, metadata: metadata[kind] },
        });
      }

      await harness.dispose();
    });

    it("rejects malformed metadata for every kind", async () => {
      const { harness, task } = await setUpArtifacts();
      const malformed = {
        // A missing required field.
        approved_plan: { approvedBy: "Roger" },
        // An unknown extra key.
        implementation_plan: {
          approvedBy: "Roger",
          approvedAt: "2026-08-29",
          approvedFor: "posterity",
        },
        // A wrong type.
        decision: {
          discovery: "x",
          decision: 42,
          why: "x",
          impact: "x",
        },
        // A member outside the evidence enum.
        evidence: { command: "npm test", exitCode: 0, evidenceKind: "smoke" },
        // A hunk that ends before it starts.
        review: {
          baseRef: "main",
          headSha: "0f2c19a",
          environmentId: null,
          concerns: [
            {
              title: "Backwards hunk",
              why: "x",
              evidence: [],
              decisions: [],
              risks: "",
              hunks: [{ path: "api/index.ts", startLine: 9, endLine: 3 }],
            },
          ],
        },
        // A negative finding count.
        review_result: { verdict: "pass", findingCounts: { Standards: -1 } },
      };

      for (const kind of TASK_ARTIFACT_KINDS) {
        await expect(
          harness.callRpc("createArtifact", {
            taskId: task.id,
            kind,
            title: `A bad ${kind}`,
            metadata: malformed[kind],
          } as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
      }

      expect(
        tasksRpcContract.listArtifacts.output.parse(
          await harness.callRpc("listArtifacts", { taskId: task.id }),
        ).artifacts,
      ).toEqual([]);
      await harness.dispose();
    });

    it("refuses metadata belonging to another kind", async () => {
      const { harness, task } = await setUpArtifacts();

      await expect(
        harness.callRpc("createArtifact", {
          taskId: task.id,
          kind: "evidence",
          title: "Evidence with a decision inside",
          metadata: validMetadata(task.id).decision,
        } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });

      await harness.dispose();
    });

    it("refuses an attachment that belongs to another task", async () => {
      const { harness, store, project, task } = await setUpArtifacts();
      const other = store.tasks.createTask({
        projectId: project.id,
        title: "Owns the attachment",
      });
      const uploaded = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${other.id}&fileName=log.txt&mime=text%2Fplain`,
        { body: "log", headers: { "content-type": "text/plain" } },
      );
      const { attachmentId } = (await uploaded.json()) as {
        attachmentId: string;
      };
      const signalsBefore = harness.realtimeSignals.length;

      const result = tasksRpcContract.createArtifact.output.parse(
        await harness.callRpc("createArtifact", {
          taskId: task.id,
          kind: "evidence",
          title: "Someone else's log",
          attachmentId,
          metadata: validMetadata(task.id).evidence,
        }),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: "artifact_attachment_mismatch",
          message: "A task artifact attachment must belong to the same task",
        },
      });
      expect(store.tasks.listTaskArtifacts(task.id)).toEqual([]);
      expect(harness.realtimeSignals).toHaveLength(signalsBefore);
      await harness.dispose();
    });

    it("accepts an attachment of its own task, including one on a comment", async () => {
      const { harness, store, task } = await setUpArtifacts();
      const comment = store.tasks.createComment({
        taskId: task.id,
        kind: "user",
        authorName: "You",
        body: "Run output",
      });
      const taskUpload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?taskId=${task.id}&fileName=task.txt&mime=text%2Fplain`,
        { body: "task blob", headers: { "content-type": "text/plain" } },
      );
      const commentUpload = await harness.fetchHttp(
        "POST",
        `/attachments/upload?commentId=${comment.id}&fileName=comment.txt&mime=text%2Fplain`,
        { body: "comment blob", headers: { "content-type": "text/plain" } },
      );
      const taskAttachmentId = (
        (await taskUpload.json()) as { attachmentId: string }
      ).attachmentId;
      const commentAttachmentId = (
        (await commentUpload.json()) as { attachmentId: string }
      ).attachmentId;

      for (const attachmentId of [taskAttachmentId, commentAttachmentId]) {
        const result = tasksRpcContract.createArtifact.output.parse(
          await harness.callRpc("createArtifact", {
            taskId: task.id,
            kind: "evidence",
            title: "Own attachment",
            attachmentId,
            metadata: validMetadata(task.id).evidence,
          }),
        );
        expect(result).toMatchObject({ ok: true, artifact: { attachmentId } });
      }

      await harness.dispose();
    });

    it("publishes tasks:changed on create and deletes idempotently", async () => {
      const { harness, store, project, task } = await setUpArtifacts();
      const created = tasksRpcContract.createArtifact.output.parse(
        await harness.callRpc("createArtifact", {
          taskId: task.id,
          kind: "review_result",
          title: "Round one",
          metadata: validMetadata(task.id).review_result,
        }),
      );
      if (!created.ok) throw new Error("artifact was rejected");
      expect(harness.realtimeSignals.at(-1)).toEqual({
        channel: "tasks:changed",
        payload: { taskId: task.id, projectId: project.id },
      });

      harness.realtimeSignals.length = 0;
      expect(
        tasksRpcContract.deleteArtifact.output.parse(
          await harness.callRpc("deleteArtifact", {
            artifactId: created.artifact.id,
          }),
        ),
      ).toEqual({ deleted: true });
      expect(harness.realtimeSignals).toEqual([
        {
          channel: "tasks:changed",
          payload: { taskId: task.id, projectId: project.id },
        },
      ]);
      expect(store.tasks.getTaskArtifact(created.artifact.id)).toBeUndefined();

      harness.realtimeSignals.length = 0;
      expect(
        tasksRpcContract.deleteArtifact.output.parse(
          await harness.callRpc("deleteArtifact", {
            artifactId: created.artifact.id,
          }),
        ),
      ).toEqual({ deleted: false });
      expect(harness.realtimeSignals).toEqual([]);
      await harness.dispose();
    });

    it("lists by kind, ordered by kind then creation", async () => {
      const { harness, store, task } = await setUpArtifacts();
      const metadata = validMetadata(task.id);
      for (const kind of ["evidence", "approved_plan", "decision"] as const) {
        const result = tasksRpcContract.createArtifact.output.parse(
          await harness.callRpc("createArtifact", {
            taskId: task.id,
            kind,
            title: `A ${kind}`,
            metadata: metadata[kind],
          }),
        );
        if (!result.ok) throw new Error(`${kind} artifact was rejected`);
      }

      // Within a kind, creation time orders and id breaks a tie. A frozen
      // clock makes every one of these a tie, and the ids are written in
      // descending order, so a listing that merely preserved insertion order
      // would come back reversed.
      const decisionIds = [
        "01ARTFCT00000000000000001Z",
        "01ARTFCT00000000000000002Z",
        "01ARTFCT00000000000000003Z",
      ];
      vi.useFakeTimers();
      try {
        for (const id of [...decisionIds].reverse()) {
          store.tasks.createTaskArtifact({
            id,
            taskId: task.id,
            kind: "decision",
            title: `Decision ${id}`,
            metadata: metadata.decision,
          });
        }
      } finally {
        vi.useRealTimers();
      }

      const listed = async (kinds?: readonly string[]) =>
        tasksRpcContract.listArtifacts.output.parse(
          await harness.callRpc("listArtifacts", {
            taskId: task.id,
            ...(kinds === undefined ? {} : { kinds: kinds as never }),
          }),
        ).artifacts;
      const list = async (kinds?: readonly string[]) =>
        (await listed(kinds)).map((artifact) => artifact.kind);

      expect(await list()).toEqual([
        "approved_plan",
        "decision",
        "decision",
        "decision",
        "decision",
        "evidence",
      ]);
      expect(
        (await listed(["decision"]))
          .map((artifact) => artifact.id)
          .filter((id) => decisionIds.includes(id)),
      ).toEqual(decisionIds);
      expect(await list(["evidence", "approved_plan"])).toEqual([
        "approved_plan",
        "evidence",
      ]);
      expect(await list([])).toEqual([]);
      await harness.dispose();
    });
  });

  it("rejects self, direct, and multi-hop cycles through the blocker RPC", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({
      name: "Cycle project",
      prefix: "CYC",
      color: "blue",
    });
    const first = store.tasks.createTask({
      projectId: project.id,
      title: "First",
    });
    const second = store.tasks.createTask({
      projectId: project.id,
      title: "Second",
    });
    const third = store.tasks.createTask({
      projectId: project.id,
      title: "Third",
    });
    const add = async (blockerTaskId: string, blockedTaskId: string) =>
      tasksRpcContract.addTaskBlocker.output.parse(
        await harness.callRpc("addTaskBlocker", {
          blockerTaskId,
          blockedTaskId,
        }),
      );

    expect(await add(first.id, first.id)).toMatchObject({
      ok: false,
      error: { code: "task_blocker_self" },
    });
    expect(await add(first.id, second.id)).toMatchObject({ ok: true });
    expect(await add(second.id, first.id)).toEqual({
      ok: false,
      error: {
        code: "task_blocker_cycle",
        message: `Adding this blocker would create a cycle: ${second.key} -> ${first.key} -> ${second.key}`,
      },
    });
    expect(await add(second.id, third.id)).toMatchObject({ ok: true });
    expect(await add(third.id, first.id)).toEqual({
      ok: false,
      error: {
        code: "task_blocker_cycle",
        message: `Adding this blocker would create a cycle: ${third.key} -> ${first.key} -> ${second.key} -> ${third.key}`,
      },
    });
    await harness.dispose();
  });
});

type PullRequestLookup =
  | { outcome: "available"; pullRequest: ReturnType<typeof makePullRequest> }
  | { outcome: "absent" }
  | { outcome: "unavailable"; message: string };

/** Full environment PR payload; tests override the fields they assert on. */
function makePullRequest(
  overrides: Partial<{
    number: number;
    title: string;
    state: "open" | "draft" | "merged" | "closed";
    url: string;
    updatedAt: string;
  }> = {},
) {
  return {
    number: 12,
    title: "Fix the pill",
    state: "open" as const,
    url: "https://github.com/acme/bb/pull/12",
    baseRefName: "main",
    headRefName: "bb/fix-the-pill",
    updatedAt: "2026-07-15T10:00:00.000Z",
    checks: {
      state: "passing" as const,
      totalCount: 1,
      passedCount: 1,
      failedCount: 0,
      pendingCount: 0,
    },
    review: { state: "none" as const, reviewRequestCount: 0 },
    mergeability: {
      state: "mergeable" as const,
      mergeStateStatus: null,
      mergeable: null,
    },
    attention: "none" as const,
    ...overrides,
  };
}
