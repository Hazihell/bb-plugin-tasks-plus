import { useMemo, useState } from "react";
import type {
  ReviewDiffUnavailableReason,
  Task,
  TaskArtifact,
} from "../../shared/contract.js";
import { isReviewStale } from "../../shared/review-diff.js";
import { useTasksQuery } from "../../shell/data.js";
import {
  ConcernSection,
  type ReviewArtifact,
  type ReviewPatch,
} from "./concern.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";

interface ReviewViewProps {
  /** Task key like TSK-4 (not the ULID). */
  taskKey: string;
  /** A specific review artifact, or null for the task's newest one. */
  artifactId: string | null;
}

/** Enough of a sha to recognise, the length the rest of the app shows. */
const SHORT_SHA_LENGTH = 7;

function ReviewSkeleton() {
  return (
    <DelayedLoading>
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <Skeleton className="mb-4 h-7 w-1/2" />
        <Skeleton className="mb-2 h-4 w-full" />
        <Skeleton className="mb-2 h-4 w-5/6" />
        <Skeleton className="h-40 w-full" />
      </div>
    </DelayedLoading>
  );
}

function EmptyNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <Icon name="FileQuestion" className="size-5" />
      {children}
    </div>
  );
}

/** Newest first by creation, matching how the artifacts section orders a kind. */
function pickReviewArtifact(
  artifacts: readonly TaskArtifact[],
  artifactId: string | null,
): ReviewArtifact | null {
  const reviews = artifacts.filter(
    (artifact): artifact is ReviewArtifact => artifact.kind === "review",
  );
  if (artifactId !== null) {
    return reviews.find((review) => review.id === artifactId) ?? null;
  }
  return (
    [...reviews].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0] ?? null
  );
}

/** Why the patches are missing, in the reader's terms rather than the API's. */
const DIFF_UNAVAILABLE_REASONS: Record<ReviewDiffUnavailableReason, string> = {
  not_a_review: "this artifact is not a review",
  artifact_not_found: "the review artifact is no longer stored",
  no_environment: "no environment is attached to this task",
  diff_unavailable: "the environment could not produce the diff",
};

/**
 * The reviewer's prose, collapsed by default. It is the same narrative the
 * concerns below carry, so it stays reachable without competing with them for
 * the document. Markdown, rendered the way every other artifact body is.
 */
function ReviewNarrative({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          className="size-3 shrink-0"
        />
        Written review
      </button>
      {open ? (
        <div className="mt-1">
          <TasksEditor
            value={body}
            onChange={() => {}}
            readOnly
            variant="comment"
          />
        </div>
      ) : null}
    </div>
  );
}

function ReviewDocument({
  task,
  artifactId,
}: {
  task: Task;
  artifactId: string | null;
}) {
  // Artifact writes republish tasks:changed, so this rides the same event.
  const artifacts = useTasksQuery(
    async (rpc) =>
      (await rpc.call("listArtifacts", { taskId: task.id })).artifacts,
    ["tasks:changed"],
    [task.id],
  );
  const review = useMemo(
    () =>
      artifacts.data === undefined
        ? null
        : pickReviewArtifact(artifacts.data, artifactId),
    [artifacts.data, artifactId],
  );
  // The diff is a separate fetch on purpose: it can fail without taking the
  // narrative — the part that is actually authored — down with it.
  // The result carries the artifact it was fetched for: this query keeps its
  // previous data while refetching, and a narrative shown with another
  // artifact's patches is worse than one shown with no patches at all.
  const diff = useTasksQuery(
    async (rpc) =>
      review === null
        ? null
        : {
            artifactId: review.id,
            result: await rpc.call("getReviewDiff", { artifactId: review.id }),
          },
    ["tasks:changed"],
    [review?.id ?? null],
  );

  if (artifacts.data === undefined) {
    return artifacts.error ? (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {artifacts.error}
      </div>
    ) : (
      <ReviewSkeleton />
    );
  }
  if (review === null) {
    return (
      <EmptyNotice>
        {artifactId === null
          ? `${task.key} has no review artifact yet.`
          : `No review artifact ${artifactId} on ${task.key}.`}
      </EmptyNotice>
    );
  }

  // A result for a different artifact is retained data mid-switch: read it as
  // still loading rather than as this review's diff.
  const result =
    diff.data != null && diff.data.artifactId === review.id
      ? diff.data.result
      : null;
  const available = result?.outcome === "available" ? result : null;
  const patches =
    available === null
      ? null
      : new Map<string, ReviewPatch>(
          available.files.map((file) => [
            file.path,
            { patch: file.patch, truncated: file.truncated },
          ]),
        );
  const stale =
    available !== null &&
    isReviewStale(available.pinnedHeadSha, available.currentHeadSha);
  // An unknown head is neither fresh nor stale, and saying nothing would read
  // as fresh.
  const unconfirmed = available !== null && available.currentHeadSha === null;
  const unavailableLine = (() => {
    if (result === null) return diff.error;
    if (result.outcome === "available") return null;
    const reason = DIFF_UNAVAILABLE_REASONS[result.reason];
    return `No patches are shown: ${reason}. ${result.message}`;
  })();

  return (
    <div className="mx-auto w-full max-w-5xl px-8 py-8">
      <header>
        <h1 className="text-2xl font-semibold leading-tight">{review.title}</h1>
        <p className="mt-1.5 font-mono text-xs text-muted-foreground">
          {review.metadata.baseRef}..
          {review.metadata.headSha.slice(0, SHORT_SHA_LENGTH)}
        </p>
        {stale ? (
          <p className="mt-3 flex gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-destructive">
            <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" />
            <span>
              The branch has moved since this review was written. The patches
              below are the current diff, not the reviewed one.
            </span>
          </p>
        ) : null}
        {unconfirmed ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Could not confirm the branch still sits at the reviewed head, so the
            patches below may not be the reviewed ones.
          </p>
        ) : null}
        {review.body ? <ReviewNarrative body={review.body} /> : null}
        {unavailableLine ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {unavailableLine}
          </p>
        ) : null}
      </header>
      {review.metadata.concerns.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          This review raised no concerns.
        </p>
      ) : (
        <div className="mt-4">
          {review.metadata.concerns.map((concern, index) => (
            <ConcernSection
              // Concern titles are free text and need not be unique; the
              // artifact's own order is the identity here.
              key={`${index}:${concern.title}`}
              concern={concern}
              artifacts={artifacts.data ?? []}
              patches={patches}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A review artifact read as a document: the narrative the reviewer wrote, with
 * each concern's own patches under it. Read-only — reviews are agent-written.
 */
export function ReviewView({ taskKey, artifactId }: ReviewViewProps) {
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("getTaskByKey", { taskKey })).task,
    ["tasks:changed"],
    [taskKey],
  );

  if (query.data === undefined) {
    return query.error ? (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {query.error}
      </div>
    ) : (
      <ReviewSkeleton />
    );
  }
  if (query.data === null) {
    return <EmptyNotice>Task {taskKey} was not found.</EmptyNotice>;
  }
  return <ReviewDocument task={query.data} artifactId={artifactId} />;
}
