import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore, TasksPageCursorError } from "./db";

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks-db-test" });
  const db = bb.storage.database();
  return { db, harness, store: createTasksStore(db) };
}

function createProject(
  store: ReturnType<typeof createTasksStore>,
  prefix: string,
) {
  return store.createProject({
    name: `${prefix} project`,
    prefix,
    color: "blue",
  });
}

function cursorForEmptyArrayFilter(
  cursor: string,
  projectId: string,
  filter: "statuses" | "priorities" | "labelIds",
): string {
  const decoded: unknown = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("expected an object cursor fixture");
  }
  const normalized = JSON.stringify({
    projectId,
    statuses: filter === "statuses" ? [] : null,
    priorities: filter === "priorities" ? [] : null,
    labelIds: filter === "labelIds" ? [] : null,
    activeOnly: false,
    parentTaskId: { specified: false, value: null },
    search: null,
    sort: "manual",
  });
  const query = createHash("sha256").update(normalized).digest("base64url");
  return Buffer.from(JSON.stringify({ ...decoded, query }), "utf8").toString(
    "base64url",
  );
}

describe("tasks storage", () => {
  it("initializes its versioned schema idempotently", async () => {
    const { db, harness } = setup();
    try {
      createTasksStore(db);
      expect(
        db
          .prepare<
            [],
            { count: number }
          >("SELECT COUNT(*) AS count FROM schema_version")
          .get()?.count,
      ).toBe(9);
    } finally {
      await harness.dispose();
    }
  });

  it("seeds, refreshes, adopts, and idempotently reopens the builtin preset", async () => {
    const { db, harness, store } = setup();
    try {
      const seeded = store
        .listPresets()
        .find((preset) => preset.name === "implement");
      expect(seeded).toMatchObject({
        name: "implement",
        providerId: "claude-code",
        modelId: "claude-opus-5[1m]",
        reasoningLevel: "medium",
        serviceTier: null,
        permissionMode: "full",
        environmentKind: "new-worktree",
        baseBranch: null,
        machineId: null,
        builtin: true,
      });
      expect(seeded?.instructions).toContain("You are the working thread");
      if (!seeded) throw new Error("expected seeded implement preset");

      store.updatePreset(seeded.id, { modelId: "user-selected-model" });
      expect(createTasksStore(db).getPreset(seeded.id)).toMatchObject({
        modelId: "user-selected-model",
        instructions: seeded.instructions,
        builtin: true,
      });

      db.prepare(
        `
          UPDATE presets
          SET provider_id = 'codex', model_id = 'gpt-5', reasoning_level = 'high',
              service_tier = 'fast', permission_mode = 'auto',
              environment_kind = 'project-default', base_branch = 'main',
              machine_id = 'host_machine', instructions = 'drifted', builtin = 0
          WHERE id = ?
        `,
      ).run(seeded.id);

      const refreshedStore = createTasksStore(db);
      const refreshed = refreshedStore.getPreset(seeded.id);
      expect(refreshed).toMatchObject({
        id: seeded.id,
        name: "implement",
        providerId: "codex",
        modelId: "gpt-5",
        reasoningLevel: "high",
        serviceTier: "fast",
        permissionMode: "auto",
        environmentKind: "project-default",
        baseBranch: "main",
        machineId: "host_machine",
        instructions: seeded.instructions,
        builtin: true,
      });

      const createdAt = refreshed?.createdAt;
      const reopenedStore = createTasksStore(db);
      expect(reopenedStore.listPresets()).toHaveLength(1);
      expect(reopenedStore.getPreset(seeded.id)?.createdAt).toBe(createdAt);

      db.prepare("DELETE FROM presets WHERE id = ?").run(seeded.id);
      const userPreset = reopenedStore.createPreset({
        name: "IMPLEMENT",
        providerId: "codex",
        modelId: "gpt-5",
        reasoningLevel: "high",
        serviceTier: null,
        permissionMode: "accept-edits",
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
        instructions: "User-owned text",
      });

      const adoptedStore = createTasksStore(db);
      const adopted = adoptedStore.getPreset(userPreset.id);
      expect(adopted).toMatchObject({
        id: userPreset.id,
        name: "implement",
        providerId: "codex",
        modelId: "gpt-5",
        reasoningLevel: "high",
        serviceTier: null,
        permissionMode: "accept-edits",
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
        instructions: seeded.instructions,
        builtin: true,
      });
      expect(adoptedStore.listPresets()).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it("migrates existing presets to the project-default environment", async () => {
    const { db, harness } = setup();
    try {
      db.exec(`
        DELETE FROM schema_version WHERE version IN (3, 6);
        DROP TABLE presets;
        CREATE TABLE presets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          reasoning_level TEXT NOT NULL,
          permission_mode TEXT NOT NULL,
          instructions TEXT NOT NULL,
          builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
          created_at TEXT NOT NULL
        );
        INSERT INTO presets (
          id, name, provider_id, model_id, reasoning_level, permission_mode,
          instructions, builtin, created_at
        ) VALUES (
          '01J00000000000000000000000', 'Legacy', 'codex', 'gpt-5', 'high',
          'full', '', 0, '2026-07-15T00:00:00.000Z'
        );
      `);

      const migrated = createTasksStore(db).getPreset(
        "01J00000000000000000000000",
      );

      expect(migrated).toMatchObject({
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
        serviceTier: null,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("migrates retired preset permission modes to Accept Edits", async () => {
    const { db, harness } = setup();
    try {
      db.exec(`
        DELETE FROM schema_version WHERE version = 5;
        INSERT INTO presets (
          id, name, provider_id, model_id, reasoning_level, permission_mode,
          instructions, builtin, created_at
        ) VALUES
          (
            '01J00000000000000000000001', 'Legacy readonly', 'codex',
            'gpt-5', 'high', 'readonly', '', 0,
            '2026-07-15T00:00:00.000Z'
          ),
          (
            '01J00000000000000000000002', 'Legacy workspace', 'codex',
            'gpt-5', 'high', 'workspace-write', '', 0,
            '2026-07-15T00:00:00.000Z'
          );
      `);

      const modes = createTasksStore(db)
        .listPresets()
        .filter((preset) => preset.name.startsWith("Legacy "))
        .map((preset) => preset.permissionMode);

      expect(modes).toEqual(["accept-edits", "accept-edits"]);
    } finally {
      await harness.dispose();
    }
  });

  it("normalizes legacy image flags to the safe raster MIME allowlist", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "IMG");
      const task = store.createTask({
        projectId: project.id,
        title: "Legacy attachment",
      });
      const svg = store.createAttachment({
        taskId: task.id,
        fileName: "active.svg",
        mime: "image/svg+xml",
        sizeBytes: 1,
        blobPath: "blobs/svg/active.svg",
        isImage: true,
      });
      const png = store.createAttachment({
        taskId: task.id,
        fileName: "safe.png",
        mime: "image/png",
        sizeBytes: 1,
        blobPath: "blobs/png/safe.png",
        isImage: false,
      });
      db.prepare("DELETE FROM schema_version WHERE version = 2").run();

      createTasksStore(db);

      expect(store.getAttachment(svg.id)?.isImage).toBe(false);
      expect(store.getAttachment(png.id)?.isImage).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  it("reports what a folder delete unfiled and nothing for a missing folder", async () => {
    const { harness, store } = setup();
    try {
      const parent = store.createFolder({ name: "Parent" });
      const child = store.createFolder({
        name: "Child",
        parentFolderId: parent.id,
      });
      const other = store.createFolder({ name: "Other" });
      const filed = store.createProject({
        name: "Filed",
        prefix: "FIL",
        color: "blue",
        folderId: parent.id,
      });
      const elsewhere = store.createProject({
        name: "Elsewhere",
        prefix: "ELS",
        color: "blue",
        folderId: other.id,
      });
      const task = store.createTask({
        projectId: filed.id,
        title: "Survives",
      });

      expect(store.deleteFolder(parent.id)).toEqual({
        deleted: true,
        movedProjectIds: [filed.id],
        movedFolderIds: [child.id],
      });
      // ON DELETE SET NULL re-parents rather than cascades.
      expect(store.getFolder(child.id)?.parentFolderId).toBeNull();
      expect(store.getProject(filed.id)?.folderId).toBeNull();
      expect(store.getProject(elsewhere.id)?.folderId).toBe(other.id);
      expect(store.getTask(task.id)?.projectId).toBe(filed.id);

      // A second delete finds no row and must not claim to have moved the
      // children the first delete already unfiled.
      expect(store.deleteFolder(parent.id)).toEqual({
        deleted: false,
        movedProjectIds: [],
        movedFolderIds: [],
      });
    } finally {
      await harness.dispose();
    }
  });

  it("allocates sequential per-project task keys transactionally", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "TSK");
      const first = store.createTask({ projectId: project.id, title: "First" });
      const second = store.createTask({
        projectId: project.id,
        title: "Second",
      });

      expect([first.key, second.key]).toEqual(["TSK-1", "TSK-2"]);
      expect(store.getProject(project.id)?.nextTaskNumber).toBe(3);
    } finally {
      await harness.dispose();
    }
  });

  it("stores, clears, and rejects blank base branches on projects and tasks", async () => {
    const { harness, store } = setup();
    try {
      const project = store.createProject({
        name: "Base branch project",
        prefix: "BB",
        color: "blue",
        baseBranch: "release-redesign",
      });
      expect(project.baseBranch).toBe("release-redesign");
      const task = store.createTask({
        projectId: project.id,
        title: "Carries its own branch",
        baseBranch: "feature/one",
      });
      expect(task.baseBranch).toBe("feature/one");

      // A default-created row inherits by carrying nothing of its own.
      expect(
        store.createTask({ projectId: project.id, title: "Inherits" })
          .baseBranch,
      ).toBe(null);

      expect(
        store.updateProject(project.id, { baseBranch: null }).baseBranch,
      ).toBe(null);
      expect(store.updateTask(task.id, { baseBranch: null }).baseBranch).toBe(
        null,
      );
      // An untouched update must not disturb the stored branch.
      store.updateTask(task.id, { baseBranch: "main" });
      expect(store.updateTask(task.id, { title: "Renamed" }).baseBranch).toBe(
        "main",
      );

      expect(() =>
        store.updateProject(project.id, { baseBranch: "  " }),
      ).toThrow("Project baseBranch");
      expect(() => store.updateTask(task.id, { baseBranch: "" })).toThrow(
        "Task baseBranch",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("enforces one level of sub-tasks in both directions", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "SUB");
      const root = store.createTask({ projectId: project.id, title: "Root" });
      const child = store.createTask({
        projectId: project.id,
        title: "Child",
        parentTaskId: root.id,
      });

      expect(() =>
        store.createTask({
          projectId: project.id,
          title: "Grandchild",
          parentTaskId: child.id,
        }),
      ).toThrow("Tasks support at most one level of sub-tasks");

      const secondRoot = store.createTask({
        projectId: project.id,
        title: "Second root",
      });
      store.createTask({
        projectId: project.id,
        title: "Second child",
        parentTaskId: secondRoot.id,
      });
      expect(() =>
        store.updateTask(secondRoot.id, { parentTaskId: root.id }),
      ).toThrow("A task with sub-tasks cannot itself become a sub-task");
    } finally {
      await harness.dispose();
    }
  });

  it("combines status, label, and active-thread filters in SQL", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "FLT");
      const label = store.createLabel({
        projectId: project.id,
        name: "Bug",
        color: "red",
      });
      const active = store.createTask({
        projectId: project.id,
        title: "Active match",
        status: "todo",
        priority: "high",
      });
      const inactive = store.createTask({
        projectId: project.id,
        title: "Inactive",
        status: "todo",
        priority: "high",
      });
      const wrongStatus = store.createTask({
        projectId: project.id,
        title: "Done active",
        status: "done",
        priority: "high",
      });
      for (const task of [active, inactive, wrongStatus]) {
        store.addTaskLabel(task.id, label.id);
      }
      for (const task of [active, wrongStatus]) {
        store.upsertTaskThread({
          taskId: task.id,
          threadId: `thr_${task.number}`,
          presetName: "Default",
          title: task.title,
          liveStatus: "working",
        });
      }

      expect(
        store.listTasks({
          projectId: project.id,
          statuses: ["todo"],
          priorities: ["high"],
          labelIds: [label.id],
          activeOnly: true,
        }),
      ).toEqual([active]);
    } finally {
      await harness.dispose();
    }
  });

  it("traverses deterministic filtered and sorted keyset pages without gaps", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "PAG");
      const bug = store.createLabel({
        projectId: project.id,
        name: "Bug",
        color: "red",
      });
      const fixtures = [
        { title: "Low later", priority: "low" as const, dueDate: "2026-08-03" },
        { title: "Urgent undated", priority: "urgent" as const, dueDate: null },
        {
          title: "High soon",
          priority: "high" as const,
          dueDate: "2026-08-01",
        },
        {
          title: "High later",
          priority: "high" as const,
          dueDate: "2026-08-02",
        },
        {
          title: "Ignored",
          priority: "urgent" as const,
          dueDate: "2026-07-01",
        },
      ].map((fixture, index) =>
        store.createTask({
          projectId: project.id,
          title: fixture.title,
          status: index === 4 ? "done" : "todo",
          priority: fixture.priority,
          dueDate: fixture.dueDate,
        }),
      );
      for (const task of fixtures.slice(0, 4)) {
        store.addTaskLabel(task.id, bug.id);
      }

      const collect = (sort: "manual" | "priority" | "due") => {
        const keys: string[] = [];
        let cursor: string | undefined;
        do {
          const page = store.listTasksPage({
            projectId: project.id,
            statuses: ["todo"],
            priorities: ["urgent", "high", "low"],
            labelIds: [bug.id],
            search: "later",
            sort,
            limit: 1,
            ...(cursor === undefined ? {} : { cursor }),
          });
          keys.push(...page.tasks.map((task) => task.key));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return keys;
      };

      expect(collect("manual")).toEqual([fixtures[0]!.key, fixtures[3]!.key]);
      expect(collect("priority")).toEqual([fixtures[3]!.key, fixtures[0]!.key]);
      expect(collect("due")).toEqual([fixtures[3]!.key, fixtures[0]!.key]);
    } finally {
      await harness.dispose();
    }
  });

  it("invalidates cursors after tasks are added, removed, reordered, or updated", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "MUT");
      const tasks = Array.from({ length: 5 }, (_, index) =>
        store.createTask({
          projectId: project.id,
          title: `Task ${index + 1}`,
          status: "todo",
        }),
      );
      const firstCursor = () => {
        const cursor = store.listTasksPage({
          projectId: project.id,
          limit: 2,
        }).nextCursor;
        expect(cursor).not.toBeNull();
        if (cursor === null) throw new Error("expected another task page");
        return cursor;
      };
      const expectStale = (cursor: string) => {
        try {
          store.listTasksPage({ projectId: project.id, limit: 2, cursor });
          throw new Error("expected stale cursor failure");
        } catch (error) {
          if (!(error instanceof TasksPageCursorError)) throw error;
          expect(error.code).toBe("stale_cursor");
        }
      };

      let cursor = firstCursor();
      store.createTask({
        projectId: project.id,
        title: "Added",
        status: "todo",
      });
      expectStale(cursor);

      cursor = firstCursor();
      store.deleteTask(tasks[4]!.id);
      expectStale(cursor);

      cursor = firstCursor();
      store.updatePosition(tasks[3]!.id, {
        status: "in_progress",
        beforeTaskId: null,
        afterTaskId: null,
      });
      expectStale(cursor);

      cursor = firstCursor();
      store.updateTask(tasks[2]!.id, { title: "Updated" });
      expectStale(cursor);
    } finally {
      await harness.dispose();
    }
  });

  it("rejects cursors reused with different filters or sorting", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "CUR");
      for (let index = 0; index < 3; index += 1) {
        store.createTask({
          projectId: project.id,
          title: `Task ${index + 1}`,
          status: "todo",
        });
      }
      const cursor = store.listTasksPage({
        projectId: project.id,
        statuses: ["todo"],
        limit: 1,
      }).nextCursor;
      if (cursor === null) throw new Error("expected another task page");

      expect(() =>
        store.listTasksPage({
          projectId: project.id,
          statuses: ["done"],
          limit: 1,
          cursor,
        }),
      ).toThrow("does not match the current filters");
      expect(() =>
        store.listTasksPage({
          projectId: project.id,
          statuses: ["todo"],
          sort: "due",
          limit: 1,
          cursor,
        }),
      ).toThrow("does not match --sort");
    } finally {
      await harness.dispose();
    }
  });

  it("validates invalid, mismatched, and stale cursors for empty array filters", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "EMP");
      for (let index = 0; index < 3; index += 1) {
        store.createTask({
          projectId: project.id,
          title: `Task ${index + 1}`,
          status: "todo",
        });
      }
      const cursor = store.listTasksPage({
        projectId: project.id,
        statuses: ["todo"],
        limit: 1,
      }).nextCursor;
      if (cursor === null) throw new Error("expected another task page");

      const filters = ["statuses", "priorities", "labelIds"] as const;
      const matchingCursors = new Map(
        filters.map((filter) => [
          filter,
          cursorForEmptyArrayFilter(cursor, project.id, filter),
        ]),
      );
      for (const filter of filters) {
        const emptyFilter = { [filter]: [] };
        expect(
          store.listTasksPage({
            projectId: project.id,
            ...emptyFilter,
            cursor: matchingCursors.get(filter),
          }),
        ).toEqual({ tasks: [], nextCursor: null });
        expect(() =>
          store.listTasksPage({
            projectId: project.id,
            ...emptyFilter,
            cursor: "not-a-cursor",
          }),
        ).toThrow("invalid task-list cursor");
        expect(() =>
          store.listTasksPage({
            projectId: project.id,
            ...emptyFilter,
            cursor,
          }),
        ).toThrow("does not match the current filters");
      }
      expect(() =>
        store.listTasksPage({
          projectId: project.id,
          statuses: [],
          limit: 0,
        }),
      ).toThrow("Task page limit must be an integer");

      store.createTask({
        projectId: project.id,
        title: "Mutation",
        status: "todo",
      });
      for (const filter of filters) {
        expect(() =>
          store.listTasksPage({
            projectId: project.id,
            [filter]: [],
            cursor: matchingCursors.get(filter),
          }),
        ).toThrow("task-list data changed after this cursor was issued");
      }
    } finally {
      await harness.dispose();
    }
  });

  it("uses fractional midpoints and renormalizes exhausted gaps", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "ORD");
      const first = store.createTask({
        projectId: project.id,
        title: "First",
        status: "todo",
      });
      const second = store.createTask({
        projectId: project.id,
        title: "Second",
        status: "todo",
      });
      const moved = store.createTask({
        projectId: project.id,
        title: "Moved",
        status: "todo",
      });
      const setPosition = db.prepare<[number, string]>(
        "UPDATE tasks SET position = ? WHERE id = ?",
      );
      setPosition.run(1, first.id);
      setPosition.run(1 + 1e-12, second.id);

      const reordered = store.updatePosition(moved.id, {
        status: "todo",
        beforeTaskId: first.id,
        afterTaskId: second.id,
      });
      const tasks = store.listTasks({
        projectId: project.id,
        statuses: ["todo"],
      });

      expect(tasks.map((task) => task.id)).toEqual([
        first.id,
        moved.id,
        second.id,
      ]);
      expect(tasks.map((task) => task.position)).toEqual([1024, 1536, 2048]);
      expect(reordered.position).toBe(1536);
    } finally {
      await harness.dispose();
    }
  });

  it("lists task comments in chronological order", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "CMT");
      const task = store.createTask({ projectId: project.id, title: "Task" });
      const later = store.createComment({
        taskId: task.id,
        kind: "agent",
        authorName: "Agent",
        body: "Later",
      });
      const earlier = store.createComment({
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        body: "Earlier",
      });
      const setCreatedAt = db.prepare<[string, string]>(
        "UPDATE comments SET created_at = ? WHERE id = ?",
      );
      setCreatedAt.run("2026-07-15T10:00:00.000Z", later.id);
      setCreatedAt.run("2026-07-15T09:00:00.000Z", earlier.id);

      expect(
        store.listComments(task.id).map((comment) => comment.body),
      ).toEqual(["Earlier", "Later"]);
    } finally {
      await harness.dispose();
    }
  });

  it("lists live task threads before terminal ones, newest first", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "THR");
      const task = store.createTask({ projectId: project.id, title: "Work" });
      const setAttachedAt = db.prepare<[string, string]>(
        "UPDATE task_threads SET attached_at = ? WHERE id = ?",
      );
      const attach = (
        threadId: string,
        liveStatus: "idle" | "working" | "failed" | "completed",
        attachedAt: string,
      ) => {
        const row = store.upsertTaskThread({
          taskId: task.id,
          threadId,
          presetName: "Attached",
          title: threadId,
          liveStatus,
        });
        setAttachedAt.run(attachedAt, row.id);
      };
      // An orchestrator respawns workers: the dead predecessors are the
      // oldest rows, the live replacement is the newest.
      attach("thr_dead_first", "failed", "2026-07-15T09:00:00.000Z");
      attach("thr_live_old", "idle", "2026-07-15T10:00:00.000Z");
      attach("thr_dead_later", "completed", "2026-07-15T11:00:00.000Z");
      attach("thr_live_new", "working", "2026-07-15T12:00:00.000Z");

      expect(
        store.listTaskThreads(task.id).map((thread) => thread.threadId),
      ).toEqual([
        "thr_live_new",
        "thr_live_old",
        "thr_dead_later",
        "thr_dead_first",
      ]);

      // Detaching removes exactly that (task, thread) row.
      const detached = store.getTaskThreadByThreadId(task.id, "thr_dead_first");
      expect(store.deleteTaskThread(detached!.id)).toBe(true);
      expect(
        store.listTaskThreads(task.id).map((thread) => thread.threadId),
      ).toEqual(["thr_live_new", "thr_live_old", "thr_dead_later"]);
    } finally {
      await harness.dispose();
    }
  });

  it("finds the latest agent comment by reply time and ignores other activity", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "LAR");
      const task = store.createTask({ projectId: project.id, title: "Task" });
      const latest = store.createComment({
        taskId: task.id,
        kind: "agent",
        authorName: "Latest responder",
        threadId: "thr_latest",
        body: "Latest agent reply",
      });
      const older = store.createComment({
        taskId: task.id,
        kind: "agent",
        authorName: "Older responder",
        threadId: "thr_older",
        body: "Older agent reply",
      });
      store.createComment({
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        body: "Newer user activity",
      });
      const setCreatedAt = db.prepare<[string, string]>(
        "UPDATE comments SET created_at = ? WHERE id = ?",
      );
      setCreatedAt.run("2026-07-15T10:00:00.000Z", older.id);
      setCreatedAt.run("2026-07-15T11:00:00.000Z", latest.id);

      expect(store.getLatestAgentComment(task.id, null)).toMatchObject({
        id: latest.id,
        threadId: "thr_latest",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("uses insertion order when agent replies share a timestamp", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "TIE");
      const task = store.createTask({ projectId: project.id, title: "Task" });
      const earlier = store.createComment({
        id: "01H00000000000000000000002",
        taskId: task.id,
        kind: "agent",
        authorName: "Earlier responder",
        threadId: "thr_earlier",
        body: "Earlier reply",
      });
      const later = store.createComment({
        // Deliberately lexicographically smaller than the earlier ID.
        id: "01H00000000000000000000001",
        taskId: task.id,
        kind: "agent",
        authorName: "Later responder",
        threadId: "thr_later",
        body: "Later reply",
      });
      const setCreatedAt = db.prepare<[string, string]>(
        "UPDATE comments SET created_at = ? WHERE id = ?",
      );
      const sharedTime = "2026-07-15T10:00:00.000Z";
      setCreatedAt.run(sharedTime, earlier.id);
      setCreatedAt.run(sharedTime, later.id);

      expect(store.listComments(task.id).map((comment) => comment.id)).toEqual([
        earlier.id,
        later.id,
      ]);
      expect(store.getLatestAgentComment(task.id, null)).toMatchObject({
        id: later.id,
        threadId: "thr_later",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("protects builtin contract fields while allowing execution and custom fields to change", async () => {
    const { harness, store } = setup();
    try {
      const builtin = store
        .listPresets()
        .find((preset) => preset.name === "implement");
      if (!builtin) throw new Error("expected seeded implement preset");

      expect(
        store.updatePreset(builtin.id, {
          modelId: "user-selected-model",
          name: builtin.name,
          instructions: builtin.instructions,
        }),
      ).toMatchObject({
        modelId: "user-selected-model",
        name: "implement",
        instructions: builtin.instructions,
        builtin: true,
      });
      expect(() =>
        store.updatePreset(builtin.id, { instructions: "changed" }),
      ).toThrow("ships with the plugin");
      expect(() =>
        store.updatePreset(builtin.id, { name: "User preset" }),
      ).toThrow("ships with the plugin");
      expect(() => store.deletePreset(builtin.id)).toThrow(
        "ships with the plugin",
      );
      expect(store.getPreset(builtin.id)).toMatchObject({
        name: "implement",
        modelId: "user-selected-model",
        instructions: builtin.instructions,
        builtin: true,
      });

      const custom = store.createPreset({
        name: "Custom",
        providerId: "openai",
        modelId: "gpt-5",
        reasoningLevel: "high",
        serviceTier: null,
        permissionMode: "accept-edits",
        environmentKind: "project-default",
        baseBranch: null,
        machineId: null,
        instructions: "Work the task.",
      });
      expect(
        store.updatePreset(custom.id, {
          instructions: "Updated instructions",
          name: "Custom renamed",
          modelId: "custom-model",
        }),
      ).toMatchObject({
        instructions: "Updated instructions",
        name: "Custom renamed",
        modelId: "custom-model",
        builtin: false,
      });
      expect(store.deletePreset(custom.id)).toBe(true);
      expect(store.getPreset(custom.id)).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });

  it("rejects duplicate preset names", async () => {
    const { harness, store } = setup();
    try {
      const preset = {
        name: "Default",
        providerId: "openai",
        modelId: "gpt-5",
        reasoningLevel: "high",
        serviceTier: null,
        permissionMode: "accept-edits",
        environmentKind: "project-default" as const,
        baseBranch: null,
        machineId: null,
        instructions: "Work the task.",
      };
      store.createPreset(preset);
      expect(() => store.createPreset(preset)).toThrow(
        /UNIQUE constraint failed: presets.name/,
      );
    } finally {
      await harness.dispose();
    }
  });

  it("derives blockers, resolves done and canceled blockers, and supports cross-project edges", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "BLK");
      const otherProject = createProject(store, "EXT");
      const doneBlocker = store.createTask({
        projectId: project.id,
        title: "Done blocker",
        status: "todo",
      });
      const canceledBlocker = store.createTask({
        projectId: otherProject.id,
        title: "Canceled blocker",
        status: "todo",
      });
      const blocked = store.createTask({
        projectId: project.id,
        title: "Dependent task",
      });

      expect(
        store.addTaskBlocker({
          blockerTaskId: doneBlocker.id,
          blockedTaskId: blocked.id,
        }),
      ).toMatchObject({ added: true });
      expect(
        store.addTaskBlocker({
          blockerTaskId: canceledBlocker.id,
          blockedTaskId: blocked.id,
        }),
      ).toMatchObject({ added: true });
      expect(store.getTask(blocked.id)).toMatchObject({
        blocked: true,
        unresolvedBlockerCount: 2,
      });
      expect(store.listTaskBlockers(blocked.id)).toEqual([
        expect.objectContaining({
          id: doneBlocker.id,
          key: doneBlocker.key,
          title: doneBlocker.title,
          status: "todo",
          projectId: project.id,
        }),
        expect.objectContaining({
          id: canceledBlocker.id,
          key: canceledBlocker.key,
          title: canceledBlocker.title,
          status: "todo",
          projectId: otherProject.id,
        }),
      ]);
      expect(store.listTaskBlocking(doneBlocker.id)).toEqual([
        expect.objectContaining({ id: blocked.id }),
      ]);

      store.updateTask(doneBlocker.id, { status: "done" });
      expect(store.getTask(blocked.id)).toMatchObject({
        blocked: true,
        unresolvedBlockerCount: 1,
      });
      store.updateTask(canceledBlocker.id, { status: "canceled" });
      expect(store.getTask(blocked.id)).toMatchObject({
        blocked: false,
        unresolvedBlockerCount: 0,
      });
      expect(store.listTaskBlockers(blocked.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: doneBlocker.id, status: "done" }),
          expect.objectContaining({
            id: canceledBlocker.id,
            status: "canceled",
          }),
        ]),
      );
    } finally {
      await harness.dispose();
    }
  });

  it("rejects self-edges and direct or multi-hop blocker cycles", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "CYC");
      const first = store.createTask({ projectId: project.id, title: "First" });
      const second = store.createTask({
        projectId: project.id,
        title: "Second",
      });
      const third = store.createTask({ projectId: project.id, title: "Third" });

      expect(() =>
        store.addTaskBlocker({
          blockerTaskId: first.id,
          blockedTaskId: first.id,
        }),
      ).toThrow("A task cannot block itself");
      store.addTaskBlocker({
        blockerTaskId: first.id,
        blockedTaskId: second.id,
      });
      expect(() =>
        store.addTaskBlocker({
          blockerTaskId: second.id,
          blockedTaskId: first.id,
        }),
      ).toThrow(`${second.key} -> ${first.key} -> ${second.key}`);
      store.addTaskBlocker({
        blockerTaskId: second.id,
        blockedTaskId: third.id,
      });
      expect(() =>
        store.addTaskBlocker({
          blockerTaskId: third.id,
          blockedTaskId: first.id,
        }),
      ).toThrow(
        `${third.key} -> ${first.key} -> ${second.key} -> ${third.key}`,
      );
    } finally {
      await harness.dispose();
    }
  });

  it("cascades blocker edges when either task is deleted", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "DEL");
      const blocker = store.createTask({
        projectId: project.id,
        title: "Blocker",
      });
      const blocked = store.createTask({
        projectId: project.id,
        title: "Blocked",
      });
      store.addTaskBlocker({
        blockerTaskId: blocker.id,
        blockedTaskId: blocked.id,
      });
      expect(store.listTaskBlocking(blocker.id)).toHaveLength(1);
      expect(store.deleteTask(blocker.id)).toBe(true);
      expect(store.listTaskBlockers(blocked.id)).toEqual([]);

      const secondBlocker = store.createTask({
        projectId: project.id,
        title: "Second blocker",
      });
      store.addTaskBlocker({
        blockerTaskId: secondBlocker.id,
        blockedTaskId: blocked.id,
      });
      expect(store.deleteTask(blocked.id)).toBe(true);
      expect(store.listTaskBlocking(secondBlocker.id)).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("recreates the task artifacts table on an existing database", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "MIG");
      const task = store.createTask({
        projectId: project.id,
        title: "Survives the migration",
      });
      db.exec(`
        DROP INDEX idx_task_artifacts_task;
        DROP TABLE task_artifacts;
        DELETE FROM schema_version WHERE version = 8;
      `);

      createTasksStore(db);

      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_artifacts'",
          )
          .get()?.name,
      ).toBe("task_artifacts");
      expect(
        db
          .prepare<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_task_artifacts_task'",
          )
          .get()?.name,
      ).toBe("idx_task_artifacts_task");
      expect(store.getTask(task.id)?.title).toBe("Survives the migration");
    } finally {
      await harness.dispose();
    }
  });

  it("rejects task artifact kinds outside the allowed set", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "KND");
      const task = store.createTask({ projectId: project.id, title: "Kinds" });
      expect(() =>
        db
          .prepare<[string, string]>(
            `
            INSERT INTO task_artifacts (
              id, task_id, kind, title, metadata_json, created_at
            ) VALUES (?, ?, 'pull_request', 'Nope', '{}', '2026-08-01T00:00:00.000Z')
          `,
          )
          .run("01J00000000000000000000010", task.id),
      ).toThrow();
      expect(
        store.createTaskArtifact({
          taskId: task.id,
          kind: "decision",
          title: "Allowed",
        }).kind,
      ).toBe("decision");
    } finally {
      await harness.dispose();
    }
  });

  it("deletes task artifacts with their task", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "CAS");
      const task = store.createTask({ projectId: project.id, title: "Doomed" });
      const artifact = store.createTaskArtifact({
        taskId: task.id,
        kind: "evidence",
        title: "Log",
      });
      expect(store.deleteTask(task.id)).toBe(true);
      expect(store.getTaskArtifact(artifact.id)).toBeUndefined();
    } finally {
      await harness.dispose();
    }
  });

  it("keeps a task artifact when its attachment is deleted", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "ATN");
      const task = store.createTask({ projectId: project.id, title: "Holds" });
      const attachment = store.createAttachment({
        taskId: task.id,
        fileName: "plan.md",
        mime: "text/markdown",
        sizeBytes: 12,
        blobPath: "blobs/md/plan.md",
        isImage: false,
      });
      const artifact = store.createTaskArtifact({
        taskId: task.id,
        kind: "approved_plan",
        title: "Approved plan",
        attachmentId: attachment.id,
      });
      expect(artifact.attachmentId).toBe(attachment.id);

      expect(store.deleteAttachment(attachment.id)).toBe(true);

      expect(store.getTaskArtifact(artifact.id)?.attachmentId).toBeNull();
    } finally {
      await harness.dispose();
    }
  });

  it("lists task artifacts by kind then creation order and filters by kind", async () => {
    const { db, harness, store } = setup();
    try {
      const project = createProject(store, "ORD");
      const task = store.createTask({
        projectId: project.id,
        title: "Ordered",
      });
      const other = store.createTask({ projectId: project.id, title: "Other" });
      const review = store.createTaskArtifact({
        taskId: task.id,
        kind: "review",
        title: "Review",
      });
      const firstDecision = store.createTaskArtifact({
        taskId: task.id,
        kind: "decision",
        title: "First decision",
      });
      const secondDecision = store.createTaskArtifact({
        taskId: task.id,
        kind: "decision",
        title: "Second decision",
      });
      const thirdDecision = store.createTaskArtifact({
        taskId: task.id,
        kind: "decision",
        title: "Third decision",
      });
      const plan = store.createTaskArtifact({
        taskId: task.id,
        kind: "approved_plan",
        title: "Plan",
      });
      store.createTaskArtifact({
        taskId: other.id,
        kind: "decision",
        title: "Elsewhere",
      });

      // Backdate the rows so creation order disagrees with timestamp order:
      // ordering by (kind, id) alone would pass otherwise. The two artifacts
      // sharing a timestamp are what proves the `id` tie-break.
      const backdate = db.prepare<[string, string]>(
        "UPDATE task_artifacts SET created_at = ? WHERE id = ?",
      );
      backdate.run("2026-01-04T00:00:00.000Z", firstDecision.id);
      backdate.run("2026-01-02T00:00:00.000Z", secondDecision.id);
      backdate.run("2026-01-02T00:00:00.000Z", thirdDecision.id);

      expect(store.listTaskArtifacts(task.id).map((a) => a.id)).toEqual([
        plan.id,
        secondDecision.id,
        thirdDecision.id,
        firstDecision.id,
        review.id,
      ]);
      expect(
        store
          .listTaskArtifacts(task.id, { kinds: ["decision"] })
          .map((a) => a.id),
      ).toEqual([secondDecision.id, thirdDecision.id, firstDecision.id]);
      expect(store.listTaskArtifacts(task.id, { kinds: [] })).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });

  it("requires a task artifact attachment to belong to the same task", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "OWN");
      const task = store.createTask({ projectId: project.id, title: "Owner" });
      const stranger = store.createTask({
        projectId: project.id,
        title: "Stranger",
      });
      const foreign = store.createAttachment({
        taskId: stranger.id,
        fileName: "foreign.md",
        mime: "text/markdown",
        sizeBytes: 3,
        blobPath: "blobs/md/foreign.md",
        isImage: false,
      });
      expect(() =>
        store.createTaskArtifact({
          taskId: task.id,
          kind: "evidence",
          title: "Borrowed",
          attachmentId: foreign.id,
        }),
      ).toThrow("A task artifact attachment must belong to the same task");

      const comment = store.createComment({
        taskId: task.id,
        kind: "agent",
        authorName: "Agent",
        body: "Evidence attached",
      });
      const owned = store.createAttachment({
        commentId: comment.id,
        fileName: "owned.md",
        mime: "text/markdown",
        sizeBytes: 3,
        blobPath: "blobs/md/owned.md",
        isImage: false,
      });
      expect(
        store.createTaskArtifact({
          taskId: task.id,
          kind: "evidence",
          title: "Owned",
          attachmentId: owned.id,
        }).attachmentId,
      ).toBe(owned.id);
    } finally {
      await harness.dispose();
    }
  });

  it("round-trips task artifact metadata and rejects non-object metadata", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "MET");
      const task = store.createTask({ projectId: project.id, title: "Meta" });
      const artifact = store.createTaskArtifact({
        taskId: task.id,
        kind: "review_result",
        title: "Result",
        metadata: { findings: 2, verdict: "pass" },
      });
      expect(store.getTaskArtifact(artifact.id)?.metadata).toEqual({
        findings: 2,
        verdict: "pass",
      });
      expect(
        store.createTaskArtifact({
          taskId: task.id,
          kind: "review_result",
          title: "Bare",
        }).metadata,
      ).toEqual({});
      expect(() =>
        store.createTaskArtifact({
          taskId: task.id,
          kind: "review_result",
          title: "Array",
          metadata: [1, 2] as unknown as Record<string, unknown>,
        }),
      ).toThrow("Task artifact metadata must be a JSON object");
      expect(() =>
        store.createTaskArtifact({
          taskId: task.id,
          kind: "review_result",
          title: "Map",
          metadata: new Map([["findings", 2]]) as unknown as Record<
            string,
            unknown
          >,
        }),
      ).toThrow("Task artifact metadata must be a JSON object");
    } finally {
      await harness.dispose();
    }
  });

  it("normalizes blank task artifact fields and deletes by id", async () => {
    const { harness, store } = setup();
    try {
      const project = createProject(store, "BLK");
      const task = store.createTask({ projectId: project.id, title: "Blank" });
      const artifact = store.createTaskArtifact({
        taskId: task.id,
        kind: "implementation_plan",
        title: "  Plan  ",
        body: "   ",
        externalUrl: "",
        sourceThreadId: "thr_abc",
      });
      expect(artifact.title).toBe("Plan");
      expect(artifact.body).toBeNull();
      expect(artifact.externalUrl).toBeNull();
      expect(artifact.sourceThreadId).toBe("thr_abc");
      const prose = store.createTaskArtifact({
        taskId: task.id,
        kind: "decision",
        title: "Prose",
        body: "  indented\n",
        externalUrl: "  https://example.test/pr/1  ",
      });
      expect(prose.body).toBe("  indented\n");
      expect(prose.externalUrl).toBe("https://example.test/pr/1");
      expect(() =>
        store.createTaskArtifact({
          taskId: task.id,
          kind: "implementation_plan",
          title: "Bad thread",
          sourceThreadId: "abc",
        }),
      ).toThrow("threadId must be a bb thr_* id");
      expect(store.deleteTaskArtifact(artifact.id)).toBe(true);
      expect(store.deleteTaskArtifact(artifact.id)).toBe(false);
    } finally {
      await harness.dispose();
    }
  });
});
