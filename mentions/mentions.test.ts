import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

import { createStore } from "../api";
import { registerMentions } from ".";

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "tasks" });
  const store = createStore(bb);
  registerMentions(bb, store);
  const provider = harness.registrations.mentionProviders[0];
  if (!provider) throw new Error("task mention provider was not registered");
  const artifactProvider = harness.registrations.mentionProviders[1];
  if (!artifactProvider) {
    throw new Error("task artifact mention provider was not registered");
  }
  return { bb, harness, provider, artifactProvider, store };
}

describe("@task mention provider", () => {
  it("searches partial keys and title words, ranks the composer's linked project first, and caps results", async () => {
    const { bb, harness, provider, store } = setup();
    try {
      const linked = store.tasks.createProject({
        name: "Linked project",
        prefix: "TSK",
        color: "blue",
        linkedBbProjectId: "proj_linked",
      });
      const other = store.tasks.createProject({
        name: "Other project",
        prefix: "OPS",
        color: "red",
      });
      const linkedTask = store.tasks.createTask({
        projectId: linked.id,
        title: "Ship keyboard navigation",
        status: "in_progress",
      });
      const otherTask = store.tasks.createTask({
        projectId: other.id,
        title: "Ship keyboard shortcuts",
        status: "todo",
      });
      bb.storage
        .database()
        .prepare<[string, string]>(
          "UPDATE tasks SET updated_at = ? WHERE id = ?",
        )
        .run("2026-07-15T18:00:00.000Z", linkedTask.id);
      bb.storage
        .database()
        .prepare<[string, string]>(
          "UPDATE tasks SET updated_at = ? WHERE id = ?",
        )
        .run("2026-07-15T19:00:00.000Z", otherTask.id);

      expect(
        await provider.search({
          trigger: "@",
          query: "tsk-1",
          projectId: null,
          threadId: null,
        }),
      ).toEqual([
        expect.objectContaining({
          id: linkedTask.id,
          title: "TSK-1 · Ship keyboard navigation",
          subtitle: "Linked project · In Progress",
        }),
      ]);
      expect(
        await provider.search({
          trigger: "@",
          query: "1",
          projectId: null,
          threadId: null,
        }),
      ).toHaveLength(2);

      const recentTitleMatches = await provider.search({
        trigger: "@",
        query: "keyboard",
        projectId: null,
        threadId: null,
      });
      expect(recentTitleMatches.map((item) => item.id)).toEqual([
        otherTask.id,
        linkedTask.id,
      ]);

      const linkedTitleMatches = await provider.search({
        trigger: "@",
        query: "keyboard",
        projectId: "proj_linked",
        threadId: "thr_composer",
      });
      expect(linkedTitleMatches.map((item) => item.id)).toEqual([
        linkedTask.id,
        otherTask.id,
      ]);

      for (let index = 0; index < 12; index += 1) {
        store.tasks.createTask({
          projectId: other.id,
          title: `Recent task ${index}`,
        });
      }
      expect(
        await provider.search({
          trigger: "@",
          query: "",
          projectId: null,
          threadId: null,
        }),
      ).toHaveLength(10);
    } finally {
      await harness.dispose();
    }
  });

  it("resolves complete task context including attachments and the CLI action contract", async () => {
    const { harness, provider, store } = setup();
    try {
      const project = store.tasks.createProject({
        name: "Mentions",
        prefix: "MEN",
        color: "blue",
      });
      const task = store.tasks.createTask({
        projectId: project.id,
        title: "Resolve rich context",
        description: "The full task description belongs in agent context.",
        status: "in_review",
        priority: "urgent",
        dueDate: "2026-07-20",
      });
      store.tasks.createTask({
        projectId: project.id,
        parentTaskId: task.id,
        title: "Verify mention output",
        status: "done",
      });
      const label = store.tasks.createLabel({
        projectId: project.id,
        name: "Agent UX",
        color: "violet",
      });
      store.tasks.addTaskLabel(task.id, label.id);
      store.tasks.createAttachment({
        taskId: task.id,
        fileName: "acceptance.md",
        mime: "text/markdown",
        sizeBytes: 42,
        blobPath: "blobs/acceptance.md",
        isImage: false,
      });
      store.tasks.createTaskArtifact({
        taskId: task.id,
        kind: "decision",
        title: "The manifest is bounded",
      });
      store.tasks.createComment({
        taskId: task.id,
        kind: "user",
        authorName: "Sawyer",
        body: "Keep the context focused.",
      });
      store.tasks.upsertTaskThread({
        taskId: task.id,
        threadId: "thr_worker",
        presetName: "Attached",
        title: "Mention worker",
        liveStatus: "working",
      });

      const { context } = await provider.resolve(task.id);
      expect(context).toContain("# MEN-1 · Resolve rich context");
      expect(context).toContain(
        "The full task description belongs in agent context.",
      );
      expect(context).toContain("MEN-2 · Verify mention output — Done");
      expect(context).toContain("### Decision");
      expect(context).toContain("- The manifest is bounded · ");
      expect(context).toContain("Fetch with: bb tasks-plus artifact show ");
      expect(context).toMatch(/- 01[0-9A-HJKMNP-TV-Z]{24} · acceptance\.md/);
      expect(context).toContain("Fetch with: bb tasks-plus attachment get ");
      expect(context).toContain("Sawyer · User");
      expect(context).toContain("thr_worker · Mention worker · Working");
      expect(context).toContain(
        "You can act on this task with the bb tasks-plus CLI.",
      );
      expect(context).toContain(
        "first run: bb tasks-plus attach MEN-1 (attaches THIS thread so the task shows you as working)",
      );
      expect(context).toContain("bb tasks-plus comment MEN-1 --body ...");
      expect(context).toContain("bb tasks-plus update MEN-1 --status ...");
    } finally {
      await harness.dispose();
    }
  });

  it("rejects an unknown task id", async () => {
    const { harness, provider } = setup();
    try {
      expect(() => provider.resolve("missing-task-id")).toThrow(
        "Task not found: missing-task-id",
      );
    } finally {
      await harness.dispose();
    }
  });
});

describe("@task-artifact mention provider", () => {
  it("registers alongside the task provider and searches title, task key and kind", async () => {
    const { harness, artifactProvider, store } = setup();
    try {
      expect(artifactProvider.id).toBe("task-artifact");
      expect(artifactProvider.label).toBe("Task artifacts");

      const linked = store.tasks.createProject({
        name: "Linked project",
        prefix: "TSK",
        color: "blue",
        linkedBbProjectId: "proj_linked",
      });
      const other = store.tasks.createProject({
        name: "Other project",
        prefix: "OPS",
        color: "red",
      });
      const linkedTask = store.tasks.createTask({
        projectId: linked.id,
        title: "Ship artifacts",
      });
      const otherTask = store.tasks.createTask({
        projectId: other.id,
        title: "Ship something else",
      });
      const linkedArtifact = store.tasks.createTaskArtifact({
        taskId: linkedTask.id,
        kind: "decision",
        title: "Manifest ordering",
      });
      const otherArtifact = store.tasks.createTaskArtifact({
        taskId: otherTask.id,
        kind: "decision",
        title: "Manifest ordering",
      });

      expect(
        await artifactProvider.search({
          trigger: "@",
          query: "manifest",
          projectId: null,
          threadId: null,
        }),
      ).toEqual([
        expect.objectContaining({
          id: otherArtifact.id,
          title: "OPS-1 · Manifest ordering",
          subtitle: "Decision · Other project",
        }),
        expect.objectContaining({ id: linkedArtifact.id }),
      ]);

      // The composer's own project outranks recency.
      const ranked = await artifactProvider.search({
        trigger: "@",
        query: "manifest",
        projectId: "proj_linked",
        threadId: "thr_composer",
      });
      expect(ranked.map((item) => item.id)).toEqual([
        linkedArtifact.id,
        otherArtifact.id,
      ]);

      const byKey = await artifactProvider.search({
        trigger: "@",
        query: "TSK-1",
        projectId: null,
        threadId: null,
      });
      expect(byKey.map((item) => item.id)).toEqual([linkedArtifact.id]);

      const byKind = await artifactProvider.search({
        trigger: "@",
        query: "decision",
        projectId: null,
        threadId: null,
      });
      expect(byKind).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });

  it("resolves the whole record: body, metadata and the artifact's source", async () => {
    const { harness, artifactProvider, store } = setup();
    try {
      const project = store.tasks.createProject({
        name: "Mentions",
        prefix: "MEN",
        color: "blue",
      });
      const task = store.tasks.createTask({
        projectId: project.id,
        title: "Resolve an artifact",
      });
      const artifact = store.tasks.createTaskArtifact({
        taskId: task.id,
        kind: "decision",
        title: "Formatter owns the cap",
        body: "The store keeps its natural order; the formatter re-sorts.",
        externalUrl: "https://example.test/decision",
        sourceThreadId: "thr_author",
        metadata: {
          discovery: "Manifests grew unbounded",
          decision: "Cap each kind at ten",
          why: "Seed prompts must stay bounded",
          impact: "Older records need one CLI call",
        },
      });

      const { context } = await artifactProvider.resolve(artifact.id);
      expect(context).toContain("# Formatter owns the cap");
      expect(context).toContain("- Kind: Decision");
      expect(context).toContain("- Task: MEN-1 · Resolve an artifact");
      expect(context).toContain("- Source thread: thr_author");
      expect(context).toContain("- Source: https://example.test/decision");
      expect(context).toContain('"decision": "Cap each kind at ten"');
      expect(context).toContain(
        "The store keeps its natural order; the formatter re-sorts.",
      );
    } finally {
      await harness.dispose();
    }
  });

  it("rejects an unknown artifact id", async () => {
    const { harness, artifactProvider } = setup();
    try {
      expect(() => artifactProvider.resolve("missing-artifact-id")).toThrow(
        "Artifact not found: missing-artifact-id",
      );
    } finally {
      await harness.dispose();
    }
  });
});
