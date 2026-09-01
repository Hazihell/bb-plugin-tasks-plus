import type {
  ReviewDraftComment,
  TaskArtifact,
} from "../../shared/contract.js";
import { TASK_ARTIFACT_KIND_LABELS } from "../../shared/artifact-manifest.js";
import type { PatchLineRange } from "../../shared/patch-slice.js";
import { ConcernDiff, type ReviewCommentActions } from "./diff.js";
import { Icon } from "@/components/ui/icon";

export type ReviewArtifact = Extract<TaskArtifact, { kind: "review" }>;
export type ReviewConcern = ReviewArtifact["metadata"]["concerns"][number];

/** One file's patch as the backend returned it, keyed by path. */
export interface ReviewPatch {
  patch: string;
  truncated: boolean;
}

interface PathHunks {
  path: string;
  ranges: PatchLineRange[];
}

/** Hunks grouped by file, in the order the concern first names each file. */
function groupHunksByPath(concern: ReviewConcern): PathHunks[] {
  const groups = new Map<string, PathHunks>();
  for (const hunk of concern.hunks) {
    const group = groups.get(hunk.path) ?? { path: hunk.path, ranges: [] };
    group.ranges.push({ startLine: hunk.startLine, endLine: hunk.endLine });
    groups.set(hunk.path, group);
  }
  return [...groups.values()];
}

/**
 * A cited artifact, resolved against the task's own record. Citations are
 * written by an agent and artifacts are never rewritten, so an id that does
 * not resolve is a stale reference, not an error worth a reader's attention.
 */
function CitedArtifacts({
  label,
  ids,
  artifacts,
}: {
  label: string;
  ids: readonly string[];
  artifacts: readonly TaskArtifact[];
}) {
  const resolved = ids
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter((artifact): artifact is TaskArtifact => artifact !== undefined);
  if (resolved.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium">{label}</span>
      {resolved.map((artifact) => (
        <span
          key={artifact.id}
          className="rounded-sm bg-secondary px-1.5 py-px text-2xs"
        >
          <span className="font-semibold">
            {TASK_ARTIFACT_KIND_LABELS[artifact.kind]}
          </span>
          <span className="pl-1.5">{artifact.title}</span>
        </span>
      ))}
    </div>
  );
}

interface ConcernSectionProps {
  concern: ReviewConcern;
  /** The task's artifacts, for resolving this concern's citations. */
  artifacts: readonly TaskArtifact[];
  /** Patches by path; null when the diff could not be fetched at all. */
  patches: ReadonlyMap<string, ReviewPatch> | null;
  /** Every unsent comment on this review; each diff card claims its own. */
  comments: readonly ReviewDraftComment[];
  actions: ReviewCommentActions;
}

/** One concern: why it matters, what it risks, what it cites, what it touched. */
export function ConcernSection({
  concern,
  artifacts,
  patches,
  comments,
  actions,
}: ConcernSectionProps) {
  const groups = groupHunksByPath(concern);
  return (
    <section className="border-t border-border-hairline py-6">
      <h2 className="text-base font-semibold">{concern.title}</h2>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
        {concern.why}
      </p>
      {concern.risks.trim().length > 0 ? (
        <p className="mt-2 flex gap-2 text-sm leading-relaxed text-muted-foreground">
          <Icon name="AlertTriangle" className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap">{concern.risks}</span>
        </p>
      ) : null}
      <CitedArtifacts
        label="Evidence"
        ids={concern.evidence}
        artifacts={artifacts}
      />
      <CitedArtifacts
        label="Decisions"
        ids={concern.decisions}
        artifacts={artifacts}
      />
      {patches === null
        ? null
        : groups.map((group) => {
            const found = patches.get(group.path);
            return found === undefined ? (
              <p
                key={group.path}
                className="mt-3 text-xs text-muted-foreground"
              >
                No patch came back for{" "}
                <span className="font-mono">{group.path}</span>.
              </p>
            ) : (
              <ConcernDiff
                key={group.path}
                path={group.path}
                patch={found.patch}
                ranges={group.ranges}
                truncated={found.truncated}
                comments={comments}
                actions={actions}
              />
            );
          })}
    </section>
  );
}
