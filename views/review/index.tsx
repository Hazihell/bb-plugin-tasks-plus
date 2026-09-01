import { useMemo, useState } from "react";
import type {
  ReviewDiffUnavailableReason,
  Task,
} from "../../shared/contract.js";
import { isReviewStale } from "../../shared/review-diff.js";
import { useTasksQuery } from "../../shell/data.js";
import { useDiffWordWrap } from "../../shell/diff-preference.js";
import { useTasksNavigation } from "../../shell/routes.js";
import {
  assignFileComments,
  ConcernSection,
  type ReviewPatch,
} from "./concern.js";
import { useReviewDrafts } from "./drafts.js";
import {
  pickReviewRound,
  RoundSwitcher,
  summariseReviewRounds,
  type ReviewRound,
} from "./rounds.js";
import { SubmitPanel } from "./submit.js";
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

/**
 * The toolbar for the patches below it. It sticks because the control it
 * carries is only wanted once a long diff is on screen, which is exactly when
 * the top of the document has scrolled away.
 *
 * Its height is fixed rather than measured: each file header sticks directly
 * under it, and a shared constant is cheaper than telling one element how tall
 * another turned out to be.
 */
function DiffToolbar({
  range,
  rounds,
  current,
  onSelectRound,
}: {
  range: string;
  rounds: readonly ReviewRound[];
  current: ReviewRound;
  onSelectRound: (round: ReviewRound) => void;
}) {
  return (
    // Bleeding into the parent's gutters would widen this past the scroller
    // on any screen too narrow to have centring slack to spend. Nothing here
    // reaches the gutters anyway, so the background stopping short of them
    // costs nothing that can be seen.
    <div className="sticky top-0 z-20 flex h-10 items-center justify-between gap-3 border-b border-border-hairline bg-background">
      {/* On a narrow screen the round matters more than the range, and only
          one of the two fits next to the wrap toggle. */}
      <span className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
        {range}
      </span>
      <RoundSwitcher
        rounds={rounds}
        current={current}
        onSelect={onSelectRound}
      />
      <WordWrapToggle />
    </div>
  );
}

/**
 * Wrapping is one setting for every diff on the screen, so the control sits
 * with the document rather than repeating on each file.
 */
function WordWrapToggle() {
  const [wrap, setWrap] = useDiffWordWrap();
  return (
    <button
      type="button"
      aria-pressed={wrap}
      className={
        "flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs " +
        (wrap
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground")
      }
      onClick={() => setWrap(!wrap)}
    >
      <Icon name="TextWrap" className="size-3.5 shrink-0" />
      Wrap lines
    </button>
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
  const navigation = useTasksNavigation();
  const rounds = useMemo(
    () => summariseReviewRounds(artifacts.data ?? []),
    [artifacts.data],
  );
  const round = useMemo(
    () =>
      artifacts.data === undefined ? null : pickReviewRound(rounds, artifactId),
    [artifacts.data, rounds, artifactId],
  );
  const review = round?.review ?? null;
  const drafts = useReviewDrafts(review?.id ?? null);
  const saveComment = drafts.saveComment;
  const deleteComment = drafts.deleteComment;
  const commentActions = useMemo(
    () => ({ save: saveComment, remove: deleteComment }),
    [saveComment, deleteComment],
  );
  // A file can be cited by several concerns; only one of them draws remarks
  // about the file itself, and that is decided here rather than by each card.
  const fileCommentPaths = useMemo(
    () => assignFileComments(review?.metadata.concerns ?? []),
    [review],
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
  if (review === null || round === null) {
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

  const range = `${review.metadata.baseRef}..${review.metadata.headSha.slice(
    0,
    SHORT_SHA_LENGTH,
  )}`;

  return (
    // No scrolling ancestor between the toolbar, the file headers and the
    // route's own scroll area: a sticky element sticks to the nearest
    // scroller, so an overflow of any kind in here would pin it to nothing.
    <div className="mx-auto w-full max-w-5xl px-8 pb-8">
      <header className="pt-8">
        <h1 className="text-2xl font-semibold leading-tight">{review.title}</h1>
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
      <DiffToolbar
        range={range}
        rounds={rounds}
        current={round}
        onSelectRound={(next) =>
          navigation.go({
            kind: "review",
            taskKey: task.key,
            artifactId: next.review.id,
          })
        }
      />
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
              comments={drafts.comments}
              fileCommentPaths={fileCommentPaths[index]!}
              actions={commentActions}
            />
          ))}
        </div>
      )}
      <SubmitPanel
        taskId={task.id}
        reviewArtifactId={review.id}
        sourceThreadId={review.sourceThreadId}
        drafts={drafts}
        onSubmitted={() => {
          drafts.resetSummary();
          drafts.refresh();
          artifacts.refresh();
        }}
      />
    </div>
  );
}

/**
 * A review artifact read as a document: the narrative the reviewer wrote, with
 * each concern's own patches under it. The prose and the concerns are the
 * agent's and are never edited here; what the human adds is comments on the
 * lines, which live as drafts until a round is submitted.
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
