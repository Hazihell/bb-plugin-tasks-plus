import type { BbPluginApi, PluginMentionItem } from "@get-bb/plugin-sdk";

import type { TasksApiStore } from "../api";
import {
  escapeLike,
  type Attachment,
  type Comment,
  type Task,
  type TaskArtifact,
  type TaskArtifactKind,
  type TaskThread,
} from "../db";
import {
  formatArtifactManifest,
  TASK_ARTIFACT_KIND_LABELS,
} from "../shared/artifact-manifest";

const SEARCH_LIMIT = 10;
const RECENT_COMMENT_LIMIT = 5;

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface MentionTaskRow {
  id: string;
  key: string;
  title: string;
  project_name: string;
  status: Task["status"];
}

interface AttachmentManifestRow {
  id: string;
  file_name: string;
}

interface MentionArtifactRow {
  id: string;
  key: string;
  title: string;
  kind: TaskArtifactKind;
  project_name: string;
}

function displayName(value: string): string {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function searchTasks(
  database: PluginDatabase,
  query: string,
  bbProjectId: string | null,
): PluginMentionItem[] {
  const normalizedQuery = query.trim();
  const search = `%${escapeLike(normalizedQuery)}%`;
  const rows = database
    .prepare<{ bbProjectId: string | null; search: string }, MentionTaskRow>(
      `
        SELECT
          t.id,
          p.prefix || '-' || t.number AS key,
          t.title,
          p.name AS project_name,
          t.status
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE @search = '%%'
          OR (p.prefix || '-' || t.number) LIKE @search ESCAPE '\\'
          OR CAST(t.number AS TEXT) LIKE @search ESCAPE '\\'
          OR t.title LIKE @search ESCAPE '\\'
        ORDER BY
          CASE
            WHEN @bbProjectId IS NOT NULL
              AND p.linked_bb_project_id = @bbProjectId THEN 0
            ELSE 1
          END,
          t.updated_at DESC,
          t.id DESC
        LIMIT ${SEARCH_LIMIT}
      `,
    )
    .all({ bbProjectId, search });

  return rows.map((row) => ({
    id: row.id,
    title: `${row.key} · ${row.title}`,
    subtitle: `${row.project_name} · ${displayName(row.status)}`,
  }));
}

function attachmentManifest(
  database: PluginDatabase,
  taskId: string,
): AttachmentManifestRow[] {
  return database
    .prepare<[string, string], AttachmentManifestRow>(
      `
        SELECT a.id, a.file_name
        FROM attachments a
        LEFT JOIN comments c ON c.id = a.comment_id
        WHERE a.task_id = ? OR c.task_id = ?
        ORDER BY a.created_at, a.id
      `,
    )
    .all(taskId, taskId);
}

function formatSubtasks(subtasks: readonly Task[]): string {
  if (subtasks.length === 0) return "None.";
  return subtasks
    .map(
      (subtask) =>
        `- ${subtask.key} · ${subtask.title} — ${displayName(subtask.status)}`,
    )
    .join("\n");
}

function formatAttachments(
  attachments: readonly Pick<Attachment, "id" | "fileName">[],
): string {
  if (attachments.length === 0) return "None.";
  return attachments
    .map(
      (attachment) =>
        `- ${attachment.id} · ${attachment.fileName}\n` +
        `  Fetch with: bb tasks-plus attachment get ${attachment.id} --out <path>`,
    )
    .join("\n");
}

function formatComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return "None.";
  return comments
    .map(
      (comment) =>
        `### ${comment.authorName} · ${displayName(comment.kind)} · ${comment.createdAt}\n\n${comment.body}`,
    )
    .join("\n\n");
}

function formatThreads(threads: readonly TaskThread[]): string {
  if (threads.length === 0) return "None.";
  return threads
    .map(
      (thread) =>
        `- ${thread.threadId} · ${thread.title} · ${displayName(thread.liveStatus)}`,
    )
    .join("\n");
}

/**
 * Artifacts are searched by what a human remembers about one: its title, the
 * task it belongs to, or its kind. Ranking mirrors searchTasks — the
 * composer's own project first, then newest.
 */
function searchArtifacts(
  database: PluginDatabase,
  query: string,
  bbProjectId: string | null,
): PluginMentionItem[] {
  const search = `%${escapeLike(query.trim())}%`;
  const rows = database
    .prepare<
      { bbProjectId: string | null; search: string },
      MentionArtifactRow
    >(
      `
        SELECT
          a.id,
          p.prefix || '-' || t.number AS key,
          a.title,
          a.kind,
          p.name AS project_name
        FROM task_artifacts a
        JOIN tasks t ON t.id = a.task_id
        JOIN projects p ON p.id = t.project_id
        WHERE @search = '%%'
          OR a.title LIKE @search ESCAPE '\\'
          OR (p.prefix || '-' || t.number) LIKE @search ESCAPE '\\'
          OR a.kind LIKE @search ESCAPE '\\'
        ORDER BY
          CASE
            WHEN @bbProjectId IS NOT NULL
              AND p.linked_bb_project_id = @bbProjectId THEN 0
            ELSE 1
          END,
          a.created_at DESC,
          a.id DESC
        LIMIT ${SEARCH_LIMIT}
      `,
    )
    .all({ bbProjectId, search });

  return rows.map((row) => ({
    id: row.id,
    title: `${row.key} · ${row.title}`,
    subtitle: `${TASK_ARTIFACT_KIND_LABELS[row.kind]} · ${row.project_name}`,
  }));
}

function artifactSource(artifact: TaskArtifact): string {
  if (artifact.externalUrl) return `- Source: ${artifact.externalUrl}`;
  if (artifact.attachmentId) {
    return `- Source: bb tasks-plus attachment get ${artifact.attachmentId} --out <path>`;
  }
  return "";
}

/**
 * The whole artifact, untruncated: it was asked for by name, so nothing here
 * is a summary. Boundedness belongs to the seed prompt's manifest, not here.
 */
function buildArtifactContext(
  store: TasksApiStore,
  artifactId: string,
): string {
  const artifact = store.tasks.getTaskArtifact(artifactId);
  if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);

  const task = store.tasks.getTask(artifact.taskId);
  if (!task) throw new Error(`Task not found: ${artifact.taskId}`);

  const lines = [
    `- Kind: ${TASK_ARTIFACT_KIND_LABELS[artifact.kind]}`,
    `- Task: ${task.key} · ${task.title}`,
    `- Created: ${artifact.createdAt}`,
    `- Source thread: ${artifact.sourceThreadId ?? "None"}`,
    artifactSource(artifact),
  ].filter((line) => line !== "");

  return `# ${artifact.title}

${lines.join("\n")}

## Metadata

\`\`\`json
${JSON.stringify(artifact.metadata, null, 2)}
\`\`\`

## Body

${artifact.body?.trim() || "No body recorded."}
`;
}

function buildTaskContext(
  store: TasksApiStore,
  database: PluginDatabase,
  taskId: string,
): string {
  const task = store.tasks.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const project = store.tasks.getProject(task.projectId);
  if (!project) throw new Error(`Project not found: ${task.projectId}`);

  const labels = store.tasks.listLabelsForTask(task.id);
  const comments = store.tasks
    .listComments(task.id)
    .slice(-RECENT_COMMENT_LIMIT);
  const attachments = attachmentManifest(database, task.id).map(
    (attachment) => ({
      id: attachment.id,
      fileName: attachment.file_name,
    }),
  );

  return `# ${task.key} · ${task.title}

## Task details

- Status: ${displayName(task.status)}
- Priority: ${displayName(task.priority)}
- Labels: ${labels.length > 0 ? labels.map((label) => label.name).join(", ") : "None"}
- Due: ${task.dueDate ?? "None"}
- Project: ${project.name}

## Description

${task.description.trim() || "No description provided."}

## Sub-tasks

${formatSubtasks(store.tasks.listSubtasks(task.id))}

## Artifacts

${formatArtifactManifest(task.key, store.tasks.listTaskArtifacts(task.id))}

## Attachments

${formatAttachments(attachments)}

## Last 5 comments

${formatComments(comments)}

## Attached threads

${formatThreads(store.tasks.listTaskThreads(task.id))}

## Action contract

You can act on this task with the bb tasks-plus CLI. If you begin working on it, first run: bb tasks-plus attach ${task.key} (attaches THIS thread so the task shows you as working). Comment substantive updates via bb tasks-plus comment ${task.key} --body ... and set status via bb tasks-plus update ${task.key} --status ...
`;
}

export function registerMentions(bb: BbPluginApi, store: TasksApiStore): void {
  const database = bb.storage.database();

  bb.ui.registerMentionProvider({
    id: "task",
    label: "Tasks",
    search({ query, projectId }) {
      return searchTasks(database, query, projectId);
    },
    resolve(itemId) {
      return { context: buildTaskContext(store, database, itemId) };
    },
  });

  bb.ui.registerMentionProvider({
    id: "task-artifact",
    label: "Task artifacts",
    search({ query, projectId }) {
      return searchArtifacts(database, query, projectId);
    },
    resolve(itemId) {
      return { context: buildArtifactContext(store, itemId) };
    },
  });
}
