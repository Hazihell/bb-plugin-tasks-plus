import {
  TASK_ARTIFACT_KINDS,
  type TaskArtifact,
  type TaskArtifactKind,
} from "./contract.js";

/** Human-readable kind names, shared by the manifest and the detail badge. */
export const TASK_ARTIFACT_KIND_LABELS: Record<TaskArtifactKind, string> = {
  approved_plan: "Approved Plan",
  implementation_plan: "Implementation Plan",
  decision: "Decision",
  evidence: "Evidence",
  review: "Review",
  review_result: "Review Result",
  review_feedback: "Review Feedback",
};

/** How many artifacts of one kind a manifest lists before it summarises. */
const KIND_LINE_LIMIT = 10;

/**
 * All a manifest line needs. Widened from the artifact union so both the
 * stored row and the RPC DTO fit without a conversion.
 */
export type ManifestArtifact = Pick<
  TaskArtifact,
  "id" | "kind" | "title" | "createdAt"
>;

/** Newest first, id descending to settle artifacts written the same millisecond. */
function newestFirst(a: ManifestArtifact, b: ManifestArtifact): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * The one grouping every reader shares: kinds in contract order, newest first
 * within a kind, empty kinds dropped. Both the manifest and the detail view
 * present artifacts in this order, so it lives in exactly one place.
 */
function groupArtifactsByKind<T extends ManifestArtifact>(
  artifacts: readonly T[],
): { kind: TaskArtifactKind; artifacts: T[] }[] {
  return TASK_ARTIFACT_KINDS.map((kind) => ({
    kind,
    artifacts: artifacts
      .filter((artifact) => artifact.kind === kind)
      .sort(newestFirst),
  })).filter((group) => group.artifacts.length > 0);
}

/** The same order, flattened, for a reader that draws its own headings. */
export function orderArtifactsByKindThenNewest<T extends ManifestArtifact>(
  artifacts: readonly T[],
): T[] {
  return groupArtifactsByKind(artifacts).flatMap((group) => group.artifacts);
}

/**
 * The task's engineering record as a bounded markdown manifest: what exists,
 * and the one command that fetches each entry. Metadata never appears here —
 * a reader who wants the substance fetches the artifact.
 */
export function formatArtifactManifest(
  taskKey: string,
  artifacts: readonly ManifestArtifact[],
): string {
  if (artifacts.length === 0) return "None.";

  const groups: string[] = [];
  for (const { kind, artifacts: ofKind } of groupArtifactsByKind(artifacts)) {
    const lines = ofKind
      .slice(0, KIND_LINE_LIMIT)
      .map(
        (artifact) =>
          `- ${artifact.title} · ${artifact.id}\n` +
          `  Fetch with: bb tasks-plus artifact show ${artifact.id}`,
      );
    const remainder = ofKind.length - KIND_LINE_LIMIT;
    if (remainder > 0) {
      lines.push(
        `… and ${remainder} more — bb tasks-plus artifact list ${taskKey} --kind ${kind}`,
      );
    }
    groups.push(`### ${TASK_ARTIFACT_KIND_LABELS[kind]}\n${lines.join("\n")}`);
  }
  return groups.join("\n\n");
}
