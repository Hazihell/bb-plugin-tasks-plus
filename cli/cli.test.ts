import { isUtf8 } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";

import { createStore } from "../api";
import plugin from "../server";
import { registerTasksCli } from "./index";

// Passthrough mock with one injectable failure: files named boom.bin fail at
// blob-write time, simulating a post-preflight persistence error so the
// create --attach partial-failure path is deterministic.
vi.mock("../attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../attachments")>();
  const saveAttachmentFromBytes: typeof actual.saveAttachmentFromBytes = async (
    store,
    bytes,
    options,
  ) => {
    if (options.fileName === "boom.bin") {
      throw new Error("simulated blob write failure");
    }
    return actual.saveAttachmentFromBytes(store, bytes, options);
  };
  return { ...actual, saveAttachmentFromBytes };
});

// Fake bb.sdk.files backed by the local filesystem, mimicking the host
// daemon's transport contract (missing-path errors, the 25 MB read cap, and
// utf8-vs-base64 content encoding). The CLI reaches invoking-machine files
// only through bb.sdk.files, so these tests stub it instead of relying on
// the plugin touching the server's disk.
function localFilesSdk() {
  return {
    read: async ({ path }: { path: string }) => {
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile()) throw new Error(`Path does not exist: ${path}`);
      if (stats.size > 25 * 1024 * 1024) {
        throw new Error(
          `File size ${stats.size} bytes exceeds the 25 MB limit`,
        );
      }
      const contents = await readFile(path);
      const contentEncoding = isUtf8(contents) ? "utf8" : "base64";
      return {
        path,
        content: contents.toString(contentEncoding),
        contentEncoding,
        sizeBytes: stats.size,
      };
    },
    write: async ({
      path,
      content,
      contentEncoding,
      createParents,
    }: {
      path: string;
      content: string;
      contentEncoding?: "utf8" | "base64";
      createParents?: boolean;
    }) => {
      if (createParents) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(content, contentEncoding ?? "utf8"));
      return { outcome: "written", path };
    },
  };
}

function stdout(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

describe("bb tasks-plus CLI", () => {
  it("lists seed-demo in help while retaining the explicit confirmation guard", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    expect(stdout(await harness.runCli(["--help"]))).toContain(
      "seed-demo                      Create sample data (requires --yes)",
    );
    await expect(harness.runCli(["seed-demo"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: "seed-demo creates sample data; re-run with --yes",
    });

    await harness.dispose();
  });

  it("runs create, list, show, update, and comment through case-insensitive key addressing", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({
              id: threadId,
              title: "CLI provider worker",
              providerId: "codex",
            }),
        },
        providers: {
          list: async () => [
            { id: "codex", displayName: "Codex", logoUrl: null },
          ],
        },
      },
    });
    await plugin(bb);

    const projectResult = await harness.runCli([
      "project",
      "create",
      "--name",
      "CLI Project",
      "--prefix",
      "CLI",
      "--json",
    ]);
    const projectPayload = JSON.parse(stdout(projectResult));
    expect(projectPayload).toMatchObject({
      project: { name: "CLI Project", prefix: "CLI" },
    });

    const labelResult = await harness.runCli([
      "label",
      "create",
      "--project",
      "cli",
      "--name",
      "Backend",
      "--json",
    ]);
    expect(JSON.parse(stdout(labelResult))).toMatchObject({
      label: { name: "Backend", projectId: projectPayload.project.id },
    });

    const createResult = await harness.runCli([
      "create",
      "--project",
      "cli",
      "--title",
      "Ship the canonical CLI",
      "--description",
      "Created from the test harness.",
      "--priority",
      "medium",
      "--label",
      "Backend",
      "--json",
    ]);
    const createPayload = JSON.parse(stdout(createResult));
    expect(createPayload).toMatchObject({
      task: {
        key: "CLI-1",
        title: "Ship the canonical CLI",
        priority: "medium",
      },
    });

    const listResult = await harness.runCli(["list", "--project", "CLI"]);
    expect(stdout(listResult)).toContain(
      "KEY    STATUS   PRIORITY  DUE  TITLE                   LABELS   AGENTS",
    );
    expect(listResult.stdout).toContain(
      "CLI-1  backlog  medium    -    Ship the canonical CLI  Backend  0",
    );

    const showResult = await harness.runCli(["show", "cli-1", "--json"]);
    const showPayload = JSON.parse(stdout(showResult));
    expect(showPayload).toMatchObject({
      task: { id: createPayload.task.id, key: "CLI-1" },
      project: { prefix: "CLI" },
      labels: [{ name: "Backend" }],
      subtasks: [],
      attachments: [],
      taskThreads: [],
      comments: [],
    });

    const updateResult = await harness.runCli([
      "update",
      "cli-1",
      "--status",
      "in_progress",
      "--priority",
      "high",
      "--due",
      "2026-07-20",
      "--json",
    ]);
    expect(JSON.parse(stdout(updateResult))).toMatchObject({
      task: {
        id: createPayload.task.id,
        status: "in_progress",
        priority: "high",
        dueDate: "2026-07-20",
      },
    });

    const commentResult = await harness.runCli(
      ["comment", "CLI-1", "--body", "Ready for review.", "--json"],
      { threadId: "thr_cli_worker", projectId: "proj_bb" },
    );
    expect(JSON.parse(stdout(commentResult))).toMatchObject({
      comment: {
        taskId: createPayload.task.id,
        kind: "agent",
        authorName: "agent (thr_cli_worker)",
        threadId: "thr_cli_worker",
        body: "Ready for review.",
        notifiedCount: 0,
      },
    });

    const updatedShow = JSON.parse(
      stdout(await harness.runCli(["show", createPayload.task.id, "--json"])),
    );
    expect(updatedShow.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "system",
          body: "Status changed to In Progress by cli",
        }),
        expect.objectContaining({
          kind: "system",
          body: "Priority changed to High by cli",
        }),
        expect.objectContaining({
          kind: "agent",
          body: "Ready for review.",
          threadTitle: "CLI provider worker",
          provider: { id: "codex", name: "Codex", logoUrl: null },
        }),
      ]),
    );

    const updatedShowTable = stdout(
      await harness.runCli(["show", createPayload.task.id]),
    );
    expect(updatedShowTable).toContain(
      "TIME                      KIND    AUTHOR               PROVIDER  BODY",
    );
    const agentRow = updatedShowTable
      .split("\n")
      .find((line) => line.includes("Ready for review."));
    expect(agentRow).toContain("agent");
    expect(agentRow).toContain("CLI provider worker");
    expect(agentRow).toContain("Codex");

    await harness.dispose();
  });

  it("sets and clears the base branch on projects and tasks", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    const project = JSON.parse(
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Branching",
          "--prefix",
          "BRN",
          "--base-branch",
          "release-redesign",
          "--json",
        ]),
      ),
    ).project;
    expect(project.baseBranch).toBe("release-redesign");

    expect(
      JSON.parse(
        stdout(
          await harness.runCli([
            "project",
            "update",
            "BRN",
            "--no-base-branch",
            "--json",
          ]),
        ),
      ).project.baseBranch,
    ).toBe(null);
    expect(
      JSON.parse(
        stdout(
          await harness.runCli([
            "project",
            "update",
            "BRN",
            "--base-branch",
            "main",
            "--json",
          ]),
        ),
      ).project.baseBranch,
    ).toBe("main");

    const task = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "BRN",
          "--title",
          "Owns a branch",
          "--base-branch",
          "feature/one",
          "--json",
        ]),
      ),
    ).task;
    expect(task.baseBranch).toBe("feature/one");

    expect(
      JSON.parse(
        stdout(
          await harness.runCli([
            "update",
            task.key,
            "--base-branch",
            "feature/two",
            "--json",
          ]),
        ),
      ).task.baseBranch,
    ).toBe("feature/two");
    expect(
      JSON.parse(
        stdout(
          await harness.runCli([
            "update",
            task.key,
            "--no-base-branch",
            "--json",
          ]),
        ),
      ).task.baseBranch,
    ).toBe(null);

    expect(stdout(await harness.runCli(["show", task.key]))).toContain(
      "Base branch",
    );
    expect(stdout(await harness.runCli(["project", "show", "BRN"]))).toContain(
      "Base branch  main",
    );

    await expect(
      harness.runCli([
        "update",
        task.key,
        "--base-branch",
        "x",
        "--no-base-branch",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "--base-branch and --no-base-branch cannot be combined",
    });
    await expect(
      harness.runCli(["update", task.key, "--base-branch", " "]),
    ).resolves.toMatchObject({ exitCode: 1 });
    await expect(
      harness.runCli(["project", "update", "BRN", "--base-branch", " "]),
    ).resolves.toMatchObject({ exitCode: 1 });

    await harness.dispose();
  });

  it("assigns and promotes task parents by key or ID with stable JSON output", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Hierarchy",
        "--prefix",
        "HIER",
      ]),
    );
    const parent = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "HIER",
          "--title",
          "Parent",
          "--json",
        ]),
      ),
    ).task;
    const child = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "HIER",
          "--title",
          "Child",
          "--json",
        ]),
      ),
    ).task;

    const assignedByKey = JSON.parse(
      stdout(
        await harness.runCli([
          "update",
          child.key,
          "--parent",
          parent.key.toLowerCase(),
          "--json",
        ]),
      ),
    );
    expect(assignedByKey).toEqual({
      task: expect.objectContaining({
        id: child.id,
        parentTaskId: parent.id,
      }),
    });

    const promoted = JSON.parse(
      stdout(
        await harness.runCli(["update", child.id, "--no-parent", "--json"]),
      ),
    );
    expect(promoted).toEqual({
      task: expect.objectContaining({
        id: child.id,
        parentTaskId: null,
      }),
    });

    const assignedById = JSON.parse(
      stdout(
        await harness.runCli([
          "update",
          child.key,
          "--parent",
          parent.id,
          "--json",
        ]),
      ),
    );
    expect(assignedById).toEqual({
      task: expect.objectContaining({
        id: child.id,
        parentTaskId: parent.id,
      }),
    });

    await harness.dispose();
  });

  it("rejects conflicting or invalid parent updates without mutation", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    for (const project of [
      { name: "Relationships", prefix: "REL" },
      { name: "Other project", prefix: "OTH" },
    ]) {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          project.name,
          "--prefix",
          project.prefix,
        ]),
      );
    }
    const taskInputs: Array<{
      project: string;
      title: string;
      parent?: string;
    }> = [
      { project: "REL", title: "Root" },
      { project: "REL", title: "Nested child", parent: "REL-1" },
      { project: "REL", title: "Movable root" },
      { project: "REL", title: "Movable child", parent: "REL-3" },
      { project: "OTH", title: "Other root" },
    ];
    for (const taskInput of taskInputs) {
      stdout(
        await harness.runCli([
          "create",
          "--project",
          taskInput.project,
          "--title",
          taskInput.title,
          ...(taskInput.parent ? ["--parent", taskInput.parent] : []),
        ]),
      );
    }

    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-1", "--no-parent"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "--parent and --no-parent cannot be combined",
    });
    await expect(harness.runCli(["update", "REL-3"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "no task changes were provided",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-3"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "A task cannot be its own parent",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "OTH-1"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "A sub-task must belong to the same project as its parent",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-2"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Tasks support at most one level of sub-tasks",
    });
    await expect(
      harness.runCli(["update", "REL-3", "--parent", "REL-1"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "A task with sub-tasks cannot itself become a sub-task",
    });

    const unchanged = JSON.parse(
      stdout(await harness.runCli(["show", "REL-3", "--json"])),
    );
    expect(unchanged.task).toMatchObject({
      key: "REL-3",
      parentTaskId: null,
    });
    expect(unchanged.subtasks).toEqual([
      expect.objectContaining({
        key: "REL-4",
        parentTaskId: unchanged.task.id,
      }),
    ]);

    await harness.dispose();
  });

  it("sorts list output by priority or due date and rejects unknown sorts", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Sorted",
        "--prefix",
        "SRT",
        "--json",
      ]),
    );
    const seed = [
      { title: "No priority", args: [] },
      {
        title: "High later",
        args: ["--priority", "high", "--due", "2026-08-01"],
      },
      {
        title: "High soon",
        args: ["--priority", "high", "--due", "2026-07-20"],
      },
      { title: "Urgent undated", args: ["--priority", "urgent"] },
    ];
    for (const task of seed) {
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "SRT",
          "--title",
          task.title,
          ...task.args,
          "--json",
        ]),
      );
    }

    const byPriority = JSON.parse(
      stdout(
        await harness.runCli([
          "list",
          "--project",
          "SRT",
          "--sort",
          "priority",
          "--json",
        ]),
      ),
    );
    expect(
      byPriority.tasks.map((task: { title: string }) => task.title),
    ).toEqual(["Urgent undated", "High soon", "High later", "No priority"]);

    const byDue = JSON.parse(
      stdout(
        await harness.runCli([
          "list",
          "--project",
          "SRT",
          "--sort",
          "due",
          "--json",
        ]),
      ),
    );
    expect(byDue.tasks.map((task: { title: string }) => task.title)).toEqual([
      "High soon",
      "High later",
      "Urgent undated",
      "No priority",
    ]);

    const invalid = await harness.runCli(["list", "--sort", "sideways"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr).toContain("invalid sort");

    await harness.dispose();
  });

  it("traverses a project whose former single JSON response exceeds 64 KiB", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const store = createStore(bb);
    const project = store.tasks.createProject({
      name: "Large project",
      prefix: "BIG",
      color: "blue",
    });
    for (let index = 0; index < 180; index += 1) {
      store.tasks.createTask({
        projectId: project.id,
        title: `Large task ${String(index + 1).padStart(3, "0")}`,
        description: `Regression payload ${index} ${"x".repeat(512)}`,
        status: index % 2 === 0 ? "todo" : "in_progress",
        priority: index % 3 === 0 ? "high" : "none",
      });
    }
    expect(
      Buffer.byteLength(
        JSON.stringify({
          tasks: store.tasks.listTasks({ projectId: project.id }),
        }),
        "utf8",
      ),
    ).toBeGreaterThan(64 * 1024);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    do {
      const result = await harness.runCli([
        "list",
        "--project",
        "BIG",
        "--sort",
        "priority",
        "--limit",
        "37",
        ...(cursor === null ? [] : ["--cursor", cursor]),
        "--json",
      ]);
      const page = JSON.parse(stdout(result)) as {
        tasks: Array<{ id: string }>;
        nextCursor: string | null;
        limit: number;
      };
      expect(page.limit).toBe(37);
      expect(page.tasks.length).toBeLessThanOrEqual(37);
      for (const task of page.tasks) {
        expect(seen.has(task.id)).toBe(false);
        seen.add(task.id);
      }
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== null);

    expect(pageCount).toBe(5);
    expect(seen.size).toBe(180);

    const human = stdout(
      await harness.runCli(["list", "--project", "BIG", "--limit", "2"]),
    );
    expect(human).toContain("More results are available.");
    expect(human).toContain("--limit 2 --cursor ");

    const invalidLimit = await harness.runCli([
      "list",
      "--project",
      "BIG",
      "--limit",
      "501",
    ]);
    expect(invalidLimit.exitCode).toBe(1);
    expect(invalidLimit.stderr).toContain(
      "--limit must be an integer from 1 to 500",
    );

    await harness.dispose();
  });

  it("defaults create and list to linked projects and auto-creates missing ones", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        projects: {
          get: async ({ projectId }) => ({
            id: projectId,
            name: "Missing BB Project",
            kind: "standard",
            sources: [],
            gitRemoteUrl: null,
            createdAt: 0,
            updatedAt: 0,
          }),
        },
      },
    });
    await plugin(bb);
    const context = { projectId: "proj_linked" };

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Linked",
        "--prefix",
        "LINK",
        "--link-bb-project",
        context.projectId,
      ]),
    );
    const task = JSON.parse(
      stdout(
        await harness.runCli(
          ["create", "--title", "Uses project context", "--json"],
          context,
        ),
      ),
    ).task;
    expect(task).toMatchObject({
      key: "LINK-1",
      title: "Uses project context",
    });

    const listed = JSON.parse(
      stdout(await harness.runCli(["list", "--json"], context)),
    );
    expect(listed.tasks).toEqual([
      expect.objectContaining({ id: task.id, agentsWorking: 0 }),
    ]);

    const firstAutoCreated = await harness.runCli(
      ["create", "--title", "Creates the missing project", "--json"],
      {
        projectId: "proj_missing",
      },
    );
    expect(firstAutoCreated).toMatchObject({
      exitCode: 0,
      stderr:
        'Created and linked tracker project "Missing BB Project" (MBP) to BB project proj_missing',
    });
    const firstAutoTask = JSON.parse(firstAutoCreated.stdout).task;
    expect(firstAutoTask).toMatchObject({
      key: "MBP-1",
      title: "Creates the missing project",
    });

    const secondAutoCreated = await harness.runCli(
      ["create", "--title", "Reuses the project"],
      { projectId: "proj_missing" },
    );
    expect(secondAutoCreated).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(secondAutoCreated.stdout).toContain(
      "Created MBP-2  Reuses the project",
    );
    expect(harness.sdk.callsTo("projects.get")).toHaveLength(1);

    const autoProjects = JSON.parse(
      stdout(await harness.runCli(["project", "list", "--json"])),
    ).projects;
    expect(autoProjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Missing BB Project",
          prefix: "MBP",
          linkedBbProjectId: "proj_missing",
        }),
      ]),
    );

    const missingContext = await harness.runCli([
      "create",
      "--title",
      "No context",
    ]);
    expect(missingContext).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "missing --project and no BB project context is available",
    });

    await harness.dispose();
  });

  it("does not create a tracker project when list has an untracked BB context", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        projects: {
          get: async () => {
            throw new Error("list must not read the BB project");
          },
        },
      },
    });
    await plugin(bb);

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Other project",
        "--prefix",
        "OTHER",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "OTHER",
        "--title",
        "Other project's task",
      ]),
    );
    expect(
      JSON.parse(
        stdout(await harness.runCli(["list", "--project", "OTHER", "--json"])),
      ).tasks,
    ).toEqual([expect.objectContaining({ title: "Other project's task" })]);

    const result = await harness.runCli(["list", "--json"], {
      projectId: "proj_untracked",
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(JSON.parse(result.stdout)).toMatchObject({ tasks: [] });
    expect(harness.sdk.callsTo("projects.get")).toEqual([]);

    await harness.dispose();
  });

  it("reports an auto-created project when task creation fails afterward", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        projects: {
          get: async ({ projectId }) => ({
            id: projectId,
            name: "Failed BB Project",
            kind: "standard",
            sources: [],
            gitRemoteUrl: null,
            createdAt: 0,
            updatedAt: 0,
          }),
        },
      },
    });
    const store = createStore(bb);
    const failingStore = {
      ...store,
      tasks: {
        ...store.tasks,
        createTask() {
          throw new Error("simulated task creation failure");
        },
      },
    };
    registerTasksCli(bb, failingStore, { name: "tasks", version: "test" });

    const result = await harness.runCli(
      ["create", "--title", "Will fail", "--json"],
      { projectId: "proj_failed" },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
    });
    expect(result.stderr).toContain(
      'Created and linked tracker project "Failed BB Project" (FBP) to BB project proj_failed',
    );
    expect(result.stderr).toContain("simulated task creation failure");
    expect(store.tasks.listProjects()).toEqual([
      expect.objectContaining({
        name: "Failed BB Project",
        prefix: "FBP",
        linkedBbProjectId: "proj_failed",
      }),
    ]);

    await harness.dispose();
  });

  it("returns single-line friendly errors for invalid statuses and unknown keys", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Errors",
        "--prefix",
        "ERR",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "ERR",
        "--title",
        "Validate errors",
      ]),
    );

    const invalidStatus = await harness.runCli([
      "update",
      "ERR-1",
      "--status",
      "almost-done",
    ]);
    expect(invalidStatus).toMatchObject({ exitCode: 1, stdout: "" });
    expect(invalidStatus.stderr).toContain("status:");
    expect(invalidStatus.stderr).toContain("Invalid option");
    expect(invalidStatus.stderr).not.toContain("\n");

    await expect(harness.runCli(["show", "ERR-404"])).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "task not found: ERR-404",
    });

    await harness.dispose();
  });

  it("validates combined project and folder updates before mutating", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Atomic project",
        "--prefix",
        "ATOM",
      ]),
    );
    stdout(
      await harness.runCli(["folder", "create", "--name", "Original folder"]),
    );

    const invalidProjectUpdate = await harness.runCli([
      "project",
      "update",
      "ATOM",
      "--rename-prefix",
      "NEXT",
      "--link-bb-project",
      "not-a-project-id",
    ]);
    expect(invalidProjectUpdate).toMatchObject({ exitCode: 1, stdout: "" });
    expect(
      JSON.parse(
        stdout(await harness.runCli(["project", "show", "ATOM", "--json"])),
      ).project,
    ).toMatchObject({ prefix: "ATOM", linkedBbProjectId: null });

    await expect(
      harness.runCli([
        "folder",
        "update",
        "Original folder",
        "--name",
        "Partially renamed",
        "--parent",
        "Missing parent",
      ]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "folder not found: Missing parent",
    });
    const folders = JSON.parse(
      stdout(await harness.runCli(["folder", "list", "--json"])),
    ).folders;
    expect(folders).toEqual([
      expect.objectContaining({
        name: "Original folder",
        parentFolderId: null,
      }),
    ]);

    await harness.dispose();
  });

  it("deletes a folder by name or id and unfiles its projects and subfolders", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const parent = JSON.parse(
      stdout(
        await harness.runCli([
          "folder",
          "create",
          "--name",
          "Parent",
          "--json",
        ]),
      ),
    ).folder;
    const child = JSON.parse(
      stdout(
        await harness.runCli([
          "folder",
          "create",
          "--name",
          "Child",
          "--parent",
          "Parent",
          "--json",
        ]),
      ),
    ).folder;
    const project = JSON.parse(
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Filed project",
          "--prefix",
          "FILED",
          "--folder",
          "Parent",
          "--json",
        ]),
      ),
    ).project;
    const task = JSON.parse(
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "FILED",
          "--title",
          "Survives folder delete",
          "--json",
        ]),
      ),
    ).task;

    await expect(
      harness.runCli(["folder", "delete", "Missing"]),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "folder not found: Missing",
    });
    await expect(harness.runCli(["folder", "delete"])).resolves.toMatchObject({
      exitCode: 1,
      stdout: "",
    });

    const deleted = JSON.parse(
      stdout(await harness.runCli(["folder", "delete", "parent", "--json"])),
    );
    expect(deleted).toMatchObject({
      deleted: true,
      folder: { id: parent.id, name: "Parent" },
      movedProjectIds: [project.id],
      movedFolderIds: [child.id],
    });

    // Nothing is destroyed: the project and subfolder move to the top level
    // and the task is untouched.
    expect(
      JSON.parse(stdout(await harness.runCli(["folder", "list", "--json"])))
        .folders,
    ).toEqual([
      expect.objectContaining({ id: child.id, parentFolderId: null }),
    ]);
    expect(
      JSON.parse(
        stdout(await harness.runCli(["project", "show", "FILED", "--json"])),
      ).project,
    ).toMatchObject({ id: project.id, folderId: null });
    expect(
      JSON.parse(stdout(await harness.runCli(["show", task.key, "--json"])))
        .task,
    ).toMatchObject({ id: task.id });

    // A second delete by id of the now-empty child folder reports no moves.
    expect(stdout(await harness.runCli(["folder", "delete", child.id]))).toBe(
      "Deleted folder Child",
    );
    await expect(
      harness.runCli(["folder", "delete", child.id]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: `folder not found: ${child.id}`,
    });

    await harness.dispose();
  });

  it("fails folder delete when another client removed the folder first", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    const store = createStore(bb);
    // Same real store and SQLite database; only the delete is wrapped so a
    // competing client's delete lands between the CLI's lookup and its own
    // delete. The store then reports `deleted: false`, which must not read
    // as success.
    const racingStore = {
      ...store,
      tasks: {
        ...store.tasks,
        deleteFolder(id: string) {
          store.tasks.deleteFolder(id);
          return store.tasks.deleteFolder(id);
        },
      },
    };
    registerTasksCli(bb, racingStore, { name: "tasks", version: "test" });
    const folder = store.tasks.createFolder({ name: "Racing" });

    const plain = await harness.runCli(["folder", "delete", "Racing"]);
    expect(plain.exitCode).toBe(1);
    expect(plain.stdout).toBe("");
    expect(plain.stderr).toContain("folder not found: Racing");

    store.tasks.createFolder({ name: "Racing" });
    const asJson = await harness.runCli([
      "folder",
      "delete",
      "Racing",
      "--json",
    ]);
    expect(asJson.exitCode).toBe(1);
    expect(asJson.stdout).toBe("");
    expect(store.tasks.getFolder(folder.id)).toBeUndefined();

    await harness.dispose();
  });

  it("creates, updates, lists, and deletes delegation presets", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        hosts: {
          list: async () => [
            { id: "host_air", name: "Sawyer Air" },
            { id: "host_box", name: "Build box" },
          ],
        },
      },
    });
    await plugin(bb);

    const created = JSON.parse(
      stdout(
        await harness.runCli([
          "preset",
          "create",
          "--name",
          "CLI worker",
          "--provider",
          "codex",
          "--model",
          "gpt-5.6-sol",
          "--reasoning",
          "high",
          "--service-tier",
          "fast",
          "--permission",
          "accept-edits",
          "--environment",
          "worktree",
          "--base-branch",
          "main",
          "--machine",
          "Sawyer Air",
          "--instructions",
          "Start with the failing test.",
          "--json",
        ]),
      ),
    ).preset;
    expect(created).toMatchObject({
      name: "CLI worker",
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
      environmentKind: "new-worktree",
      baseBranch: "main",
      machineId: "host_air",
      builtin: false,
    });
    const shown = stdout(
      await harness.runCli(["preset", "show", "CLI worker"]),
    );
    expect(shown).toContain("Environment   worktree");
    expect(shown).toContain("Base branch   main");
    expect(shown).toContain("Machine       host_air");
    expect(shown).toContain("Service tier  fast");

    const updated = JSON.parse(
      stdout(
        await harness.runCli([
          "preset",
          "update",
          "CLI worker",
          "--reasoning",
          "ultra",
          "--service-tier",
          "none",
          "--name",
          "CLI reviewer",
          "--environment",
          "project-default",
          "--json",
        ]),
      ),
    ).preset;
    expect(updated).toMatchObject({
      id: created.id,
      name: "CLI reviewer",
      reasoningLevel: "ultra",
      serviceTier: null,
      environmentKind: "project-default",
      baseBranch: null,
      machineId: null,
    });

    const listTable = stdout(await harness.runCli(["preset", "list"]));
    expect(listTable).toContain("ENVIRONMENT");
    expect(listTable).toContain("BASE BRANCH");
    expect(listTable).toContain("MACHINE");
    expect(listTable).toContain("SERVICE TIER");

    const listed = JSON.parse(
      stdout(await harness.runCli(["preset", "list", "--json"])),
    ).presets;
    expect(listed).toEqual([
      expect.objectContaining({ name: "implement", builtin: true }),
      expect.objectContaining({ id: created.id, name: "CLI reviewer" }),
    ]);

    const builtinShown = stdout(
      await harness.runCli(["preset", "show", "IMPLEMENT", "--json"]),
    );
    expect(JSON.parse(builtinShown).preset).toMatchObject({
      name: "implement",
      providerId: "claude-code",
      modelId: "claude-opus-5[1m]",
      builtin: true,
    });

    const builtinUpdated = JSON.parse(
      stdout(
        await harness.runCli([
          "preset",
          "update",
          "IMPLEMENT",
          "--model",
          "user-selected-model",
          "--json",
        ]),
      ),
    ).preset;
    expect(builtinUpdated).toMatchObject({
      name: "implement",
      modelId: "user-selected-model",
      builtin: true,
    });

    for (const args of [
      ["preset", "update", "IMPLEMENT", "--instructions", "changed"],
      ["preset", "update", "IMPLEMENT", "--name", "User preset"],
      ["preset", "delete", "IMPLEMENT"],
    ]) {
      await expect(harness.runCli(args)).resolves.toMatchObject({
        exitCode: 1,
        stdout: "",
        stderr: expect.stringContaining("ships with the plugin"),
      });
    }

    expect(
      JSON.parse(
        stdout(
          await harness.runCli(["preset", "delete", "CLI reviewer", "--json"]),
        ),
      ),
    ).toMatchObject({ deleted: true, preset: { id: created.id } });

    await harness.dispose();
  });

  it("reports friendly preset target validation errors", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    const required = [
      "preset",
      "create",
      "--name",
      "Invalid target",
      "--provider",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "--reasoning",
      "high",
      "--permission",
      "full",
    ];

    await expect(
      harness.runCli([...required, "--environment", "branch"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr:
        "invalid --environment branch; expected project-default or worktree",
    });
    await expect(
      harness.runCli([...required, "--base-branch", "main"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "--base-branch requires --environment worktree",
    });
    await expect(
      harness.runCli([...required, "--machine", "missing"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "--machine requires --environment worktree",
    });

    await harness.dispose();
  });

  it("self-attaches through BB_THREAD_ID and lists the live thread status", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_cli_self",
            title: "CLI self attach",
            titleFallback: null,
            status: "active",
          }),
          send: async () => undefined,
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Attach",
        "--prefix",
        "ATT",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "ATT",
        "--title",
        "Attach this worker",
      ]),
    );

    const previousThreadId = process.env.BB_THREAD_ID;
    process.env.BB_THREAD_ID = "thr_cli_self";
    try {
      expect(
        JSON.parse(stdout(await harness.runCli(["attach", "ATT-1", "--json"]))),
      ).toMatchObject({ task: { key: "ATT-1" }, threadId: "thr_cli_self" });
    } finally {
      if (previousThreadId === undefined) delete process.env.BB_THREAD_ID;
      else process.env.BB_THREAD_ID = previousThreadId;
    }

    const threads = JSON.parse(
      stdout(await harness.runCli(["threads", "ATT-1", "--json"])),
    );
    expect(threads.taskThreads).toEqual([
      expect.objectContaining({
        threadId: "thr_cli_self",
        liveStatus: "working",
        presetName: "Attached",
      }),
    ]);
    const taskStore = createStore(bb).tasks;
    taskStore.createComment({
      taskId: threads.task.id,
      kind: "agent",
      authorName: "Prior worker",
      threadId: "thr_prior_worker",
      body: "Prior reply from another agent.",
    });

    const notified = JSON.parse(
      stdout(
        await harness.runCli(
          [
            "comment",
            "ATT-1",
            "--body",
            "Include the new edge case.",
            "--author",
            "Custom CLI agent",
            "--notify",
            "--json",
          ],
          { threadId: "thr_cli_sender", projectId: "proj_bb" },
        ),
      ),
    ).comment;
    expect(notified).toMatchObject({
      taskId: threads.task.id,
      kind: "agent",
      authorName: "Custom CLI agent",
      threadId: "thr_cli_sender",
      body: "Include the new edge case.",
      notifiedCount: 1,
    });
    expect(taskStore.getComment(notified.id)).toMatchObject({
      kind: "agent",
      authorName: "Custom CLI agent",
      threadId: "thr_cli_sender",
      notifiedCount: 1,
    });
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        expect.objectContaining({
          threadId: "thr_prior_worker",
          mode: "steer-if-active",
        }),
      ],
    ]);

    await harness.dispose();
  });

  it("detaches a thread with `bb tasks-plus detach` and lists live threads first", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: threadId === "thr_dead_worker" ? "error" : "idle",
          }),
          send: async () => undefined,
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Detach",
        "--prefix",
        "DET",
      ]),
    );
    stdout(
      await harness.runCli(["create", "--project", "DET", "--title", "Work"]),
    );

    expect(stdout(await harness.runCli(["--help"]))).toContain(
      "detach                         Detach an agent thread from a task",
    );

    // An orchestrator attaches a worker, it dies, and a replacement is
    // attached: the list must lead with the live replacement.
    stdout(
      await harness.runCli(["attach", "DET-1", "--thread", "thr_dead_worker"]),
    );
    stdout(
      await harness.runCli(["attach", "DET-1", "--thread", "thr_live_worker"]),
    );
    const listed = JSON.parse(
      stdout(await harness.runCli(["threads", "DET-1", "--json"])),
    );
    expect(
      listed.taskThreads.map((thread: { threadId: string }) => thread.threadId),
    ).toEqual(["thr_live_worker", "thr_dead_worker"]);

    expect(
      stdout(
        await harness.runCli([
          "detach",
          "DET-1",
          "--thread",
          "thr_dead_worker",
        ]),
      ),
    ).toBe("Detached thr_dead_worker from DET-1");
    await expect(
      harness.runCli(["detach", "DET-1", "--thread", "thr_dead_worker"]),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "Thread thr_dead_worker is not attached to DET-1",
    });

    // Without --thread the command targets the invoking thread, like attach.
    const previousThreadId = process.env.BB_THREAD_ID;
    process.env.BB_THREAD_ID = "thr_live_worker";
    try {
      expect(
        JSON.parse(stdout(await harness.runCli(["detach", "DET-1", "--json"]))),
      ).toMatchObject({ task: { key: "DET-1" }, threadId: "thr_live_worker" });
      delete process.env.BB_THREAD_ID;
      await expect(harness.runCli(["detach", "DET-1"])).resolves.toMatchObject({
        exitCode: 1,
        stderr: "missing --thread and BB_THREAD_ID is not set",
      });
    } finally {
      if (previousThreadId === undefined) delete process.env.BB_THREAD_ID;
      else process.env.BB_THREAD_ID = previousThreadId;
    }
    expect(
      JSON.parse(stdout(await harness.runCli(["threads", "DET-1", "--json"])))
        .taskThreads,
    ).toEqual([]);

    await harness.dispose();
  });

  it("creates a task with --attach files after validating every source path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const notesPath = join(directory, "notes.txt");
    const pngPath = join(directory, "pixel.png");
    await writeFile(notesPath, "attach me at create\n", "utf8");
    await writeFile(
      pngPath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Attach",
          "--prefix",
          "ATT",
        ]),
      );

      // A bad path fails before anything is created — no half-built task.
      const missing = await harness.runCli([
        "create",
        "--project",
        "att",
        "--title",
        "Broken attach",
        "--attach",
        join(directory, "missing.bin"),
      ]);
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain("attachment source is not a file");

      // Preflight also enforces the shared 25 MB upload limit.
      const hugePath = join(directory, "huge.bin");
      await writeFile(hugePath, "");
      await truncate(hugePath, 25 * 1024 * 1024 + 1);
      const oversized = await harness.runCli([
        "create",
        "--project",
        "att",
        "--title",
        "Oversized attach",
        "--attach",
        hugePath,
      ]);
      expect(oversized.exitCode).toBe(1);
      expect(oversized.stderr).toContain("exceeds the 25 MB limit");

      expect(
        JSON.parse(
          stdout(await harness.runCli(["list", "--project", "att", "--json"])),
        ).tasks,
      ).toEqual([]);

      const created = JSON.parse(
        stdout(
          await harness.runCli([
            "create",
            "--project",
            "att",
            "--title",
            "Starts with files",
            "--attach",
            notesPath,
            "--attach",
            pngPath,
            "--json",
          ]),
        ),
      );
      expect(created.task).toMatchObject({ key: "ATT-1" });
      expect(created.failedAttachments).toEqual([]);
      expect(created.attachments).toEqual([
        expect.objectContaining({
          taskId: created.task.id,
          commentId: null,
          fileName: "notes.txt",
          isImage: false,
        }),
        expect.objectContaining({
          taskId: created.task.id,
          commentId: null,
          fileName: "pixel.png",
          mime: "image/png",
          isImage: true,
        }),
      ]);

      const outputPath = join(directory, "roundtrip.txt");
      stdout(
        await harness.runCli([
          "attachment",
          "get",
          created.attachments[0].id,
          "--out",
          outputPath,
        ]),
      );
      expect(await readFile(outputPath, "utf8")).toBe("attach me at create\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });

  it("attempts every --attach file after create and reports failures truthfully", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const firstPath = join(directory, "first.txt");
    const boomPath = join(directory, "boom.bin");
    const lastPath = join(directory, "last.txt");
    await writeFile(firstPath, "first", "utf8");
    await writeFile(boomPath, "will fail at blob write", "utf8");
    await writeFile(lastPath, "last", "utf8");
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Mixed",
          "--prefix",
          "MIX",
        ]),
      );

      // JSON mode: middle file fails, both neighbors are still attempted.
      const mixed = await harness.runCli([
        "create",
        "--project",
        "mix",
        "--title",
        "Mixed outcome",
        "--attach",
        firstPath,
        "--attach",
        boomPath,
        "--attach",
        lastPath,
        "--json",
      ]);
      expect(mixed.exitCode).toBe(1);
      expect(mixed.stderr).toContain("1 of 3 attachments failed");
      const payload = JSON.parse(mixed.stdout);
      expect(payload.task).toMatchObject({ key: "MIX-1" });
      expect(
        payload.attachments.map(
          (attachment: { fileName: string }) => attachment.fileName,
        ),
      ).toEqual(["first.txt", "last.txt"]);
      expect(payload.failedAttachments).toEqual([
        { path: boomPath, error: "simulated blob write failure" },
      ]);
      // Both successes really persisted on the created task.
      const listed = JSON.parse(
        stdout(await harness.runCli(["attachment", "list", "MIX-1", "--json"])),
      );
      expect(listed.attachments).toHaveLength(2);

      // Human mode reports the same outcome with a per-file recovery command.
      const human = await harness.runCli([
        "create",
        "--project",
        "mix",
        "--title",
        "Mixed outcome again",
        "--attach",
        firstPath,
        "--attach",
        boomPath,
      ]);
      expect(human.exitCode).toBe(1);
      expect(human.stdout).toContain("Created MIX-2");
      expect(human.stdout).toContain("Attached first.txt");
      expect(human.stdout).toContain(
        `Failed to attach ${boomPath}: simulated blob write failure`,
      );
      expect(human.stdout).toContain(
        `Retry with: bb tasks-plus attachment add MIX-2 --file ${boomPath}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });

  it("shows attached-thread pull requests in show output and JSON", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: "active",
            environmentId:
              threadId === "thr_pr_worker"
                ? "env_pr"
                : threadId === "thr_absent_pr"
                  ? "env_absent"
                  : null,
          }),
        },
        environments: {
          pullRequest: async ({ environmentId }: { environmentId: string }) =>
            environmentId === "env_absent"
              ? { outcome: "absent" }
              : {
                  outcome: "available",
                  pullRequest: {
                    number: 12,
                    title: "BB-15 Show PRs in tasks",
                    state: "draft",
                    url: "https://github.com/acme/bb/pull/12",
                    baseRefName: "main",
                    headRefName: "bb/bb-15",
                    updatedAt: "2026-07-16T10:00:00.000Z",
                    checks: {
                      state: "pending",
                      totalCount: 1,
                      passedCount: 0,
                      failedCount: 0,
                      pendingCount: 1,
                    },
                    review: { state: "none", reviewRequestCount: 0 },
                    mergeability: {
                      state: "draft",
                      mergeStateStatus: null,
                      mergeable: null,
                    },
                    attention: "draft",
                  },
                },
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "PRs",
        "--prefix",
        "PRS",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "PRS",
        "--title",
        "Ship the pill",
      ]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_pr_worker"]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_no_env_00"]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_absent_pr"]),
    );

    const shown = stdout(await harness.runCli(["show", "PRS-1"]));
    expect(shown).toContain("Pull requests");
    expect(shown).toContain("#12  draft  BB-15 Show PRs in tasks");
    expect(shown).toContain("https://github.com/acme/bb/pull/12");
    // Genuine absence (no environment, or gh reported no PR) stays quiet —
    // it must not read as a failed lookup.
    expect(shown).not.toContain("PR lookup unavailable");

    const payload = JSON.parse(
      stdout(await harness.runCli(["show", "PRS-1", "--json"])),
    );
    expect(payload.pullRequests).toEqual([
      {
        url: "https://github.com/acme/bb/pull/12",
        number: 12,
        title: "BB-15 Show PRs in tasks",
        state: "draft",
        updatedAt: "2026-07-16T10:00:00.000Z",
        threadIds: ["thr_pr_worker"],
      },
    ]);
    expect(payload.pullRequestUnavailableThreadIds).toEqual([]);

    await harness.dispose();
  });

  it("flags threads whose PR lookup failed in show output", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({
            id: threadId,
            title: `Worker ${threadId}`,
            titleFallback: null,
            status: "active",
            environmentId: "env_down",
          }),
        },
        environments: {
          pullRequest: async () => ({
            outcome: "unavailable",
            message: "gh pr view failed: authentication required",
          }),
        },
      },
    });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "PRs",
        "--prefix",
        "PRS",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "PRS",
        "--title",
        "Ship the pill",
      ]),
    );
    stdout(
      await harness.runCli(["attach", "PRS-1", "--thread", "thr_down_0000"]),
    );

    const shown = stdout(await harness.runCli(["show", "PRS-1"]));
    expect(shown).toContain("PR lookup unavailable for: thr_down_0000");

    await harness.dispose();
  });

  it("adds and downloads an attachment with an exact file round-trip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const inputPath = join(directory, "input.txt");
    const pngPath = join(directory, "pixel.png");
    const outputPath = join(directory, "nested", "output.txt");
    await writeFile(inputPath, "attachment bytes from CLI\n", "utf8");
    await writeFile(
      pngPath,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Files",
          "--prefix",
          "FILE",
        ]),
      );
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "FILE",
          "--title",
          "Round-trip a file",
        ]),
      );

      const attachment = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "add",
            "FILE-1",
            "--file",
            inputPath,
            "--name",
            "renamed.txt",
            "--json",
          ]),
        ),
      ).attachment;
      expect(attachment).toMatchObject({
        fileName: "renamed.txt",
        mime: "application/octet-stream",
        sizeBytes: 26,
        isImage: false,
      });

      const signalsBeforePng = harness.realtimeSignals.length;
      const pngAttachment = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "add",
            "FILE-1",
            "--file",
            pngPath,
            "--json",
          ]),
        ),
      ).attachment;
      expect(pngAttachment).toMatchObject({
        fileName: "pixel.png",
        mime: "image/png",
        sizeBytes: 8,
        isImage: true,
      });
      expect(harness.realtimeSignals.slice(signalsBeforePng)).toEqual([
        {
          channel: "tasks:changed",
          payload: {
            taskId: pngAttachment.taskId,
            projectId: expect.any(String),
          },
        },
      ]);

      stdout(
        await harness.runCli([
          "update",
          "FILE-1",
          "--description",
          `![pixel](/api/v1/plugins/tasks-plus/http/attachments/download?attachmentId=${pngAttachment.id})`,
        ]),
      );
      const signalsBeforeReferencedRemove = harness.realtimeSignals.length;
      const referencedRemove = await harness.runCli([
        "attachment",
        "remove",
        pngAttachment.id,
      ]);
      expect(referencedRemove.exitCode).toBe(1);
      expect(referencedRemove.stderr).toContain(
        "is used in the task description",
      );
      expect(harness.realtimeSignals).toHaveLength(
        signalsBeforeReferencedRemove,
      );

      const listed = JSON.parse(
        stdout(
          await harness.runCli(["attachment", "list", "FILE-1", "--json"]),
        ),
      );
      expect(listed.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: attachment.id }),
          expect.objectContaining({ id: pngAttachment.id }),
        ]),
      );

      const comment = JSON.parse(
        stdout(
          await harness.runCli([
            "comment",
            "FILE-1",
            "--body",
            "Attach the source to this comment.",
            "--json",
          ]),
        ),
      ).comment;
      const commentAttachment = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "add",
            comment.id,
            "--file",
            inputPath,
            "--json",
          ]),
        ),
      ).attachment;
      expect(commentAttachment).toMatchObject({
        taskId: null,
        commentId: comment.id,
      });
      const listedWithCommentAttachment = JSON.parse(
        stdout(
          await harness.runCli(["attachment", "list", "FILE-1", "--json"]),
        ),
      );
      expect(listedWithCommentAttachment.attachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: attachment.id }),
          expect.objectContaining({ id: commentAttachment.id }),
        ]),
      );

      stdout(
        await harness.runCli([
          "attachment",
          "get",
          attachment.id,
          "--out",
          outputPath,
        ]),
      );
      expect(await readFile(outputPath, "utf8")).toBe(
        "attachment bytes from CLI\n",
      );

      const removed = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "remove",
            attachment.id,
            "--json",
          ]),
        ),
      );
      expect(removed).toMatchObject({
        deleted: true,
        attachment: { id: attachment.id },
      });
      const afterRemove = JSON.parse(
        stdout(
          await harness.runCli(["attachment", "list", "FILE-1", "--json"]),
        ),
      );
      expect(
        afterRemove.attachments.map((entry: { id: string }) => entry.id),
      ).not.toContain(attachment.id);

      // Removing an already-gone id is an explicit CLI error, not a silent 0.
      const removeMissing = await harness.runCli([
        "attachment",
        "remove",
        attachment.id,
      ]);
      expect(removeMissing.exitCode).toBe(1);
      expect(removeMissing.stderr).toContain("attachment not found");

      const removedReferenced = JSON.parse(
        stdout(
          await harness.runCli([
            "attachment",
            "remove",
            pngAttachment.id,
            "--remove-references",
            "--json",
          ]),
        ),
      );
      expect(removedReferenced).toMatchObject({
        deleted: true,
        attachment: { id: pngAttachment.id },
      });
      const shownAfterReferencedRemove = JSON.parse(
        stdout(await harness.runCli(["show", "FILE-1", "--json"])),
      );
      expect(shownAfterReferencedRemove.task.description).not.toContain(
        pngAttachment.id,
      );
    } finally {
      await harness.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes file flags to the invoking thread's machine and honors --machine", async () => {
    // Files that exist only on the remote enrolled machine, never on the
    // server's filesystem — the CLI must reach them via bb.sdk.files with
    // the resolved hostId.
    const remoteFiles = new Map<string, Buffer>([
      ["/remote/notes.md", Buffer.from("remote description\n", "utf8")],
      [
        "/remote/shot.png",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ],
    ]);
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) =>
            makeThreadResponse({ id: threadId, environmentId: "env-remote" }),
        },
        environments: {
          get: async () => ({ hostId: "machine-remote" }),
        },
        hosts: {
          list: async () => [{ id: "machine-remote", name: "Remote Laptop" }],
        },
        files: {
          read: async ({ path }: { path: string }) => {
            const contents = remoteFiles.get(path);
            if (!contents) throw new Error(`Path does not exist: ${path}`);
            const contentEncoding = isUtf8(contents) ? "utf8" : "base64";
            return {
              path,
              content: contents.toString(contentEncoding),
              contentEncoding,
              sizeBytes: contents.byteLength,
            };
          },
          write: async ({
            path,
            content,
            contentEncoding,
          }: {
            path: string;
            content: string;
            contentEncoding?: "utf8" | "base64";
          }) => {
            remoteFiles.set(path, Buffer.from(content, contentEncoding));
            return { outcome: "written", path };
          },
        },
      },
    });
    await plugin(bb);
    const threadCtx = { threadId: "thr_remote_worker", cwd: "/remote" };

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Remote",
        "--prefix",
        "REM",
      ]),
    );
    const created = JSON.parse(
      stdout(
        await harness.runCli(
          [
            "create",
            "--project",
            "REM",
            "--title",
            "Remote files",
            "--description-file",
            "notes.md",
            "--attach",
            "shot.png",
            "--json",
          ],
          threadCtx,
        ),
      ),
    );
    expect(created.task).toMatchObject({
      key: "REM-1",
      description: "remote description\n",
    });
    expect(created.attachments).toEqual([
      expect.objectContaining({ fileName: "shot.png", mime: "image/png" }),
    ]);
    // Every client file read resolved the thread's machine.
    for (const [args] of harness.sdk.callsTo("files.read")) {
      expect(args).toMatchObject({ hostId: "machine-remote" });
    }

    stdout(
      await harness.runCli(
        [
          "attachment",
          "get",
          created.attachments[0].id,
          "--out",
          "fetched/shot.png",
        ],
        threadCtx,
      ),
    );
    expect(harness.sdk.callsTo("files.write")).toEqual([
      [
        expect.objectContaining({
          hostId: "machine-remote",
          path: "/remote/fetched/shot.png",
          contentEncoding: "base64",
          createParents: true,
        }),
      ],
    ]);
    expect(remoteFiles.get("/remote/fetched/shot.png")).toEqual(
      remoteFiles.get("/remote/shot.png"),
    );

    // --machine overrides by name without any thread context.
    stdout(
      await harness.runCli([
        "attachment",
        "add",
        "REM-1",
        "--file",
        "/remote/notes.md",
        "--machine",
        "Remote Laptop",
      ]),
    );
    const lastRead = harness.sdk.callsTo("files.read").at(-1)!;
    expect(lastRead[0]).toMatchObject({
      hostId: "machine-remote",
      path: "/remote/notes.md",
    });

    await harness.dispose();
  });

  it("returns a friendly dispatch error when the task project is not linked", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Unlinked CLI",
        "--prefix",
        "UNL",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "UNL",
        "--title",
        "Cannot dispatch yet",
      ]),
    );
    stdout(
      await harness.runCli([
        "preset",
        "create",
        "--name",
        "CLI worker",
        "--provider",
        "codex",
        "--model",
        "gpt-5.6-sol",
        "--reasoning",
        "high",
        "--permission",
        "full",
      ]),
    );

    const result = await harness.runCli([
      "dispatch",
      "UNL-1",
      "--preset",
      "CLI worker",
    ]);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: 'Task project "Unlinked CLI" is not linked to a bb project',
    });
    // "delegate" stays as a hidden compatibility alias for "dispatch".
    const aliased = await harness.runCli([
      "delegate",
      "UNL-1",
      "--preset",
      "CLI worker",
    ]);
    expect(aliased.stderr).toBe(
      'Task project "Unlinked CLI" is not linked to a bb project',
    );
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([]);

    await harness.dispose();
  });

  it("manages blockers, distinguishes resolved blockers, and shows both directions", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
    await plugin(bb);

    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "Local blockers",
        "--prefix",
        "LOC",
      ]),
    );
    stdout(
      await harness.runCli([
        "project",
        "create",
        "--name",
        "External blockers",
        "--prefix",
        "EXT",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "LOC",
        "--title",
        "Blocked task",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "LOC",
        "--title",
        "Resolved prerequisite",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "LOC",
        "--title",
        "Dependent task",
      ]),
    );
    stdout(
      await harness.runCli([
        "create",
        "--project",
        "EXT",
        "--title",
        "External prerequisite",
      ]),
    );

    const added = JSON.parse(
      stdout(await harness.runCli(["blocker", "add", "LOC-1", "EXT-1", "--json"])),
    );
    expect(added).toMatchObject({
      task: { key: "LOC-1" },
      blocker: { key: "EXT-1" },
      ok: true,
      added: true,
      relation: {
        blockerTaskId: added.blocker.id,
        blockedTaskId: added.task.id,
      },
    });
    const idempotent = JSON.parse(
      stdout(await harness.runCli(["blocker", "add", "LOC-1", "EXT-1", "--json"])),
    );
    expect(idempotent).toMatchObject({ ok: true, added: false });

    stdout(await harness.runCli(["blocker", "add", "LOC-1", "LOC-2"]));
    stdout(await harness.runCli(["update", "LOC-2", "--status", "done"]));
    stdout(await harness.runCli(["blocker", "add", "LOC-3", "LOC-1"]));

    const listed = JSON.parse(
      stdout(await harness.runCli(["blocker", "list", "LOC-1", "--json"])),
    );
    expect(listed).toMatchObject({
      task: { key: "LOC-1", blocked: true, unresolvedBlockerCount: 1 },
      unresolvedCount: 1,
      blockers: expect.arrayContaining([
        expect.objectContaining({ key: "EXT-1", status: "backlog" }),
        expect.objectContaining({ key: "LOC-2", status: "done" }),
      ]),
    });
    expect(
      listed.blockers.find((blocker) => blocker.key === "EXT-1").projectId,
    ).not.toBe(listed.task.projectId);

    const humanList = stdout(
      await harness.runCli(["blocker", "list", "LOC-1"]),
    );
    expect(humanList).toContain("STATE");
    expect(humanList).toContain("UNRESOLVED");
    expect(humanList).toContain("RESOLVED");
    expect(humanList).toContain("EXT — External blockers");

    const blockedUpdate = await harness.runCli([
      "update",
      "LOC-1",
      "--status",
      "in_progress",
    ]);
    expect(blockedUpdate.exitCode).toBe(1);
    expect(blockedUpdate.stderr).toContain("LOC-1 is blocked by unresolved task");
    expect(blockedUpdate.stderr).toContain("Resolve the listed blocker(s)");

    const cycle = await harness.runCli([
      "blocker",
      "add",
      "LOC-1",
      "LOC-3",
    ]);
    expect(cycle.exitCode).toBe(1);
    expect(cycle.stderr).toContain("Cannot add blocker");
    expect(cycle.stderr).toContain("dependency graph remains acyclic");

    const shown = JSON.parse(
      stdout(await harness.runCli(["show", "LOC-1", "--json"])),
    );
    expect(shown.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "EXT-1" }),
        expect.objectContaining({ key: "LOC-2", status: "done" }),
      ]),
    );
    expect(shown.blocking).toEqual([
      expect.objectContaining({ key: "LOC-3", projectId: shown.task.projectId }),
    ]);
    const shownHuman = stdout(await harness.runCli(["show", "LOC-1"]));
    expect(shownHuman).toContain("Blocked by");
    expect(shownHuman).toContain("Blocking");
    expect(shownHuman).toContain("EXT — External blockers");

    stdout(await harness.runCli(["blocker", "rm", "LOC-1", "LOC-2"]));
    const missingEdge = await harness.runCli([
      "blocker",
      "rm",
      "LOC-1",
      "LOC-2",
      "--json",
    ]);
    expect(JSON.parse(stdout(missingEdge))).toMatchObject({ removed: false });

    await harness.dispose();
  });

  it("records artifacts, filters them by kind, and shows one by id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const planMeta = join(directory, "plan.json");
    const decisionMeta = join(directory, "decision.json");
    const evidenceMeta = join(directory, "evidence.json");
    await writeFile(
      planMeta,
      JSON.stringify({ approvedBy: "Roger", approvedAt: "2026-08-30" }),
      "utf8",
    );
    await writeFile(
      decisionMeta,
      JSON.stringify({
        discovery: "The CLI owned kind validation nowhere.",
        decision: "Validate the kind in the CLI.",
        why: "A union discriminant produces an unreadable error.",
        impact: "One more branch before the task lookup.",
      }),
      "utf8",
    );
    await writeFile(
      evidenceMeta,
      JSON.stringify({
        command: "npm run test -- cli",
        exitCode: 0,
        evidenceKind: "unit",
      }),
      "utf8",
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: {
        files: localFilesSdk(),
        threads: {
          get: async ({ threadId }) =>
            makeThreadResponse({ id: threadId, title: "Artifact writer" }),
        },
      },
    });
    await plugin(bb);

    try {
      expect(stdout(await harness.runCli(["--help"]))).toContain(
        "artifact add|list|show|remove",
      );
      expect(stdout(await harness.runCli(["artifact", "--help"]))).toContain(
        "bb tasks-plus artifact add <key> --kind <kind>",
      );

      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Artifacts",
          "--prefix",
          "ART",
        ]),
      );
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "ART",
          "--title",
          "Carry durable records",
        ]),
      );

      const added = JSON.parse(
        stdout(
          await harness.runCli(
            [
              "artifact",
              "add",
              "art-1",
              "--kind",
              "approved_plan",
              "--title",
              "Approved build plan",
              "--meta-file",
              planMeta,
              "--body",
              "# Plan\n\nDo the thing.",
              "--url",
              "https://example.invalid/plan",
              "--json",
            ],
            { threadId: "thr_artifact_writer", projectId: "proj_bb" },
          ),
        ),
      );
      expect(added).toMatchObject({
        artifact: {
          kind: "approved_plan",
          title: "Approved build plan",
          externalUrl: "https://example.invalid/plan",
          attachmentId: null,
          sourceThreadId: "thr_artifact_writer",
          metadata: { approvedBy: "Roger", approvedAt: "2026-08-30" },
        },
        attachment: null,
      });
      // The --json envelopes are a contract with the skills that read them, so
      // pin the top-level keys, not just the values inside.
      expect(Object.keys(added).sort()).toEqual(["artifact", "attachment"]);

      const humanAdd = stdout(
        await harness.runCli([
          "artifact",
          "add",
          "ART-1",
          "--kind",
          "decision",
          "--title",
          "Validate kinds in the CLI",
          "--meta-file",
          decisionMeta,
        ]),
      );
      expect(humanAdd).toContain("Added decision artifact");
      // Invoked outside a thread, so nothing is recorded as the source.
      const decisionId = humanAdd.trim().split(/\s+/).at(-1)!;
      stdout(
        await harness.runCli([
          "artifact",
          "add",
          "ART-1",
          "--kind",
          "evidence",
          "--title",
          "CLI suite passes",
          "--meta-file",
          evidenceMeta,
        ]),
      );

      const everything = JSON.parse(
        stdout(await harness.runCli(["artifact", "list", "ART-1", "--json"])),
      );
      expect(Object.keys(everything).sort()).toEqual(["artifacts", "task"]);
      expect(everything.task).toMatchObject({ key: "ART-1" });
      expect(
        everything.artifacts.map((artifact: { kind: string }) => artifact.kind),
      ).toEqual(
        expect.arrayContaining(["approved_plan", "decision", "evidence"]),
      );

      const filtered = JSON.parse(
        stdout(
          await harness.runCli([
            "artifact",
            "list",
            "ART-1",
            "--kind",
            "decision",
            "--json",
          ]),
        ),
      );
      expect(
        filtered.artifacts.map((artifact: { kind: string }) => artifact.kind),
      ).toEqual(["decision"]);

      const twoKinds = JSON.parse(
        stdout(
          await harness.runCli([
            "artifact",
            "list",
            "ART-1",
            "--kind",
            "decision",
            "--kind",
            "evidence",
            "--json",
          ]),
        ),
      );
      expect(
        twoKinds.artifacts
          .map((artifact: { kind: string }) => artifact.kind)
          .sort(),
      ).toEqual(["decision", "evidence"]);

      const listTable = stdout(
        await harness.runCli(["artifact", "list", "ART-1"]),
      );
      expect(listTable).toContain("ID");
      expect(listTable).toContain("KIND");
      expect(listTable).toContain("CREATED");
      expect(listTable).toContain("Approved build plan");

      const shown = stdout(
        await harness.runCli(["artifact", "show", decisionId]),
      );
      expect(shown).toContain(`ID          ${decisionId}`);
      expect(shown).toContain("Task        ART-1");
      expect(shown).toContain("Kind        decision");
      expect(shown).toContain("Metadata");
      // detail() one-lines its values, so the metadata block sits outside it.
      expect(shown).toContain('"discovery": "The CLI owned kind validation');

      const shownJson = JSON.parse(
        stdout(await harness.runCli(["artifact", "show", decisionId, "--json"])),
      );
      expect(shownJson).toMatchObject({
        artifact: { id: decisionId, kind: "decision" },
      });
      expect(Object.keys(shownJson)).toEqual(["artifact"]);

      const missing = await harness.runCli([
        "artifact",
        "show",
        "0000000000000000000000MISS",
      ]);
      expect(missing).toMatchObject({
        exitCode: 1,
        stderr: "artifact not found: 0000000000000000000000MISS",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });

  it("rejects an unknown kind and unusable metadata before writing anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const goodMeta = join(directory, "plan.json");
    const malformedMeta = join(directory, "broken.json");
    const wrongShapeMeta = join(directory, "blank-approver.json");
    await writeFile(
      goodMeta,
      JSON.stringify({ approvedBy: "Roger", approvedAt: "2026-08-30" }),
      "utf8",
    );
    await writeFile(malformedMeta, "{ approvedBy: nope", "utf8");
    await writeFile(
      wrongShapeMeta,
      JSON.stringify({ approvedBy: "  ", approvedAt: "2026-08-30" }),
      "utf8",
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Guards",
          "--prefix",
          "GRD",
        ]),
      );
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "GRD",
          "--title",
          "Guarded task",
        ]),
      );

      const unknownKind = await harness.runCli([
        "artifact",
        "add",
        "GRD-1",
        "--kind",
        "postmortem",
        "--title",
        "Not a kind",
        "--meta-file",
        goodMeta,
      ]);
      expect(unknownKind.exitCode).toBe(1);
      expect(unknownKind.stderr).toContain('unknown kind "postmortem"');
      expect(unknownKind.stderr).toContain(
        "approved_plan, implementation_plan, decision, evidence, review, review_result",
      );

      const missingMeta = await harness.runCli([
        "artifact",
        "add",
        "GRD-1",
        "--kind",
        "approved_plan",
        "--title",
        "No metadata",
      ]);
      expect(missingMeta).toMatchObject({
        exitCode: 1,
        stderr: "missing required --meta-file",
      });

      const malformed = await harness.runCli([
        "artifact",
        "add",
        "GRD-1",
        "--kind",
        "approved_plan",
        "--title",
        "Malformed metadata",
        "--meta-file",
        malformedMeta,
      ]);
      expect(malformed.exitCode).toBe(1);
      expect(malformed.stderr).toContain("--meta-file is not valid JSON");

      const wrongShape = await harness.runCli([
        "artifact",
        "add",
        "GRD-1",
        "--kind",
        "approved_plan",
        "--title",
        "Blank approver",
        "--meta-file",
        wrongShapeMeta,
      ]);
      expect(wrongShape.exitCode).toBe(1);
      expect(wrongShape.stderr).toContain("metadata.approvedBy");
      expect(wrongShape.stderr).toContain("must not be blank");

      const unreadable = await harness.runCli([
        "artifact",
        "add",
        "GRD-1",
        "--kind",
        "approved_plan",
        "--title",
        "Missing file",
        "--meta-file",
        join(directory, "absent.json"),
      ]);
      expect(unreadable.exitCode).toBe(1);
      expect(unreadable.stderr).toContain("could not read");

      // Nothing above reached the database.
      expect(
        JSON.parse(
          stdout(await harness.runCli(["artifact", "list", "GRD-1", "--json"])),
        ).artifacts,
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });

  it("attaches a payload to an artifact in one call and removes the artifact once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-tasks-cli-"));
    const metaPath = join(directory, "evidence.json");
    const logPath = join(directory, "vitest.log");
    await writeFile(
      metaPath,
      JSON.stringify({
        command: "npm run test -- cli",
        exitCode: 0,
        evidenceKind: "unit",
      }),
      "utf8",
    );
    await writeFile(logPath, "all suites passed\n", "utf8");
    const { bb, harness } = createFakePluginHost({
      pluginId: "tasks",
      sdk: { files: localFilesSdk() },
    });
    await plugin(bb);

    try {
      stdout(
        await harness.runCli([
          "project",
          "create",
          "--name",
          "Payloads",
          "--prefix",
          "PAY",
        ]),
      );
      stdout(
        await harness.runCli([
          "create",
          "--project",
          "PAY",
          "--title",
          "Carries a log",
        ]),
      );

      const added = JSON.parse(
        stdout(
          await harness.runCli([
            "artifact",
            "add",
            "PAY-1",
            "--kind",
            "evidence",
            "--title",
            "Suite output",
            "--meta-file",
            metaPath,
            "--attach",
            logPath,
            "--json",
          ]),
        ),
      );
      expect(added.attachment).toMatchObject({ fileName: "vitest.log" });
      expect(added.artifact.attachmentId).toBe(added.attachment.id);

      const roundtrip = join(directory, "roundtrip.log");
      stdout(
        await harness.runCli([
          "attachment",
          "get",
          added.attachment.id,
          "--out",
          roundtrip,
        ]),
      );
      expect(await readFile(roundtrip, "utf8")).toBe("all suites passed\n");

      const removed = JSON.parse(
        stdout(
          await harness.runCli([
            "artifact",
            "remove",
            added.artifact.id,
            "--json",
          ]),
        ),
      );
      expect(removed).toMatchObject({
        deleted: true,
        artifact: { id: added.artifact.id, kind: "evidence" },
      });
      expect(Object.keys(removed).sort()).toEqual(["artifact", "deleted"]);

      const again = await harness.runCli([
        "artifact",
        "remove",
        added.artifact.id,
      ]);
      expect(again).toMatchObject({
        exitCode: 1,
        stderr: `artifact not found: ${added.artifact.id}`,
      });

      expect(
        JSON.parse(
          stdout(await harness.runCli(["artifact", "list", "PAY-1", "--json"])),
        ).artifacts,
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await harness.dispose();
    }
  });
});
