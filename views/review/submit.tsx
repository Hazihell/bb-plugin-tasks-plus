import { useState } from "react";
import type {
  ReviewDraftComment,
  ReviewVerdict,
  SubmitReviewFeedbackResult,
} from "../../shared/contract.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import type { ReviewDraftStore } from "./drafts.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";

/** The verdicts in the order a reviewer weighs them, mildest last. */
const VERDICTS: { verdict: ReviewVerdict; label: string; hint: string }[] = [
  {
    verdict: "approve",
    label: "Approve",
    hint: "Recorded on the task. Nothing is sent to a thread.",
  },
  {
    verdict: "request_changes",
    label: "Request changes",
    hint: "Sent to a thread, with an instruction to review again when done.",
  },
  {
    verdict: "comment",
    label: "Comment",
    hint: "Sent to a thread as remarks, with nothing asked in return.",
  },
];

/** Why the round did not go out, in the reviewer's terms rather than the API's. */
const SUBMIT_FAILURE_REASONS: Record<
  Extract<SubmitReviewFeedbackResult, { outcome: "failed" }>["reason"],
  string
> = {
  not_a_review: "that artifact is not a review",
  artifact_not_found: "the review artifact is no longer stored",
  no_target_thread: "no thread could be found or started to send this to",
  spawn_failed: "the new thread could not be started",
  send_failed: "the thread would not take the message",
};

/** Where one unsent comment points, short enough for a list. */
function commentLocation(comment: ReviewDraftComment): string {
  const anchor = comment.anchor;
  if (anchor.anchor === "file") return anchor.path;
  return anchor.startLine === anchor.endLine
    ? `${anchor.path}:${anchor.startLine}`
    : `${anchor.path}:${anchor.startLine}-${anchor.endLine}`;
}

/** `new` is not a thread id, so the picker's value is a union, not a string. */
type Target = { kind: "existing"; threadId: string } | { kind: "new" };

interface SubmitPanelProps {
  taskId: string;
  reviewArtifactId: string;
  /** The thread that wrote the review; the reply's natural home. */
  sourceThreadId: string | null;
  drafts: ReviewDraftStore;
  onSubmitted: () => void;
}

/**
 * The end of a round: what the reviewer concluded, and where it goes.
 *
 * Approving needs no thread — it is a record, not a message — so the picker
 * only appears for the two verdicts that are delivered. A submit that fails
 * leaves everything on screen exactly as it was: the drafts are still drafts,
 * and the reviewer can pick a different thread and try again.
 */
export function SubmitPanel({
  taskId,
  reviewArtifactId,
  sourceThreadId,
  drafts,
  onSubmitted,
}: SubmitPanelProps) {
  const rpc = useTasksRpc();
  const threads = useTasksQuery(
    async (query) =>
      (await query.call("listTaskThreads", { taskId })).taskThreads,
    ["threads:changed"],
    [taskId],
  );
  const [verdict, setVerdict] = useState<ReviewVerdict>("comment");
  const [chosen, setChosen] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  // The review's own thread is the default, but only once it is known to be
  // one of the task's — an unattached thread is not on offer here. Derived
  // rather than seeded into state: the threads arrive after the first paint,
  // and a default written on their arrival would land on top of a choice the
  // reviewer had already made.
  const attached = threads.data ?? [];
  const preselected: Target | null =
    attached.length === 0
      ? null
      : {
          kind: "existing",
          threadId: (
            attached.find((thread) => thread.threadId === sourceThreadId) ??
            attached[0]!
          ).threadId,
        };
  const target = chosen ?? preselected;

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    setSent(null);
    try {
      // The note is saved behind a debounce, and the server sends what it has
      // stored: a note typed a moment ago must land before the round does.
      await drafts.flushSummary();
      const result = await rpc.call("submitReviewFeedback", {
        reviewArtifactId,
        verdict,
        target: verdict === "approve" ? null : target,
      });
      if (result.outcome === "failed") {
        setFailure(
          `Nothing was sent: ${SUBMIT_FAILURE_REASONS[result.reason]}. ${result.message}`,
        );
      } else {
        setSent(
          result.threadId === null
            ? "Approval recorded on the task."
            : "Sent. The round is now on the task's record.",
        );
        onSubmitted();
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const unsent = drafts.comments.length;
  // An approval is a record and stands on its own; anything that gets sent to
  // a thread has to actually say something.
  const nothingToSay =
    verdict !== "approve" &&
    unsent === 0 &&
    drafts.summary.trim().length === 0;

  return (
    <section className="mt-8 border-t border-border-hairline pt-6">
      <h2 className="text-base font-semibold">Answer this review</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {unsent === 0
          ? "No comments yet — select lines in a patch above to leave one."
          : `${unsent} unsent ${unsent === 1 ? "comment" : "comments"} go out with this round.`}
      </p>
      {unsent > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {drafts.comments.map((comment) => (
            <li
              key={comment.id}
              className="flex min-w-0 items-baseline gap-2 text-xs"
            >
              <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                {commentLocation(comment)}
              </span>
              <span className="min-w-0 flex-1 truncate">{comment.body}</span>
              <button
                type="button"
                aria-label={`Discard the comment on ${commentLocation(comment)}`}
                className="shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => void drafts.deleteComment(comment.id)}
              >
                <Icon name="Trash2" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <Textarea
        rows={3}
        value={drafts.summary}
        aria-label="Overall note"
        placeholder="An overall note (optional)"
        className="mt-4 text-sm"
        onChange={(event) => drafts.setSummary(event.target.value)}
      />

      <div className="mt-3 flex flex-wrap gap-2">
        {VERDICTS.map((option) => (
          <button
            key={option.verdict}
            type="button"
            aria-pressed={verdict === option.verdict}
            className={
              "rounded-md border px-2.5 py-1 text-xs " +
              (verdict === option.verdict
                ? "border-foreground bg-secondary text-foreground"
                : "border-border text-muted-foreground hover:text-foreground")
            }
            onClick={() => setVerdict(option.verdict)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {VERDICTS.find((option) => option.verdict === verdict)!.hint}
      </p>

      {verdict === "approve" ? null : (
        <div className="mt-3 flex flex-wrap gap-2">
          {attached.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              aria-pressed={
                target?.kind === "existing" &&
                target.threadId === thread.threadId
              }
              className={
                "flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs " +
                (target?.kind === "existing" &&
                target.threadId === thread.threadId
                  ? "border-foreground bg-secondary text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground")
              }
              onClick={() =>
                setChosen({ kind: "existing", threadId: thread.threadId })
              }
            >
              <Icon name="MessageSquare" className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {thread.title || thread.presetName}
              </span>
              {thread.threadId === sourceThreadId ? (
                <span className="shrink-0 text-2xs text-muted-foreground">
                  wrote this review
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={target?.kind === "new"}
            className={
              "flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs " +
              (target?.kind === "new"
                ? "border-foreground bg-secondary text-foreground"
                : "border-border text-muted-foreground hover:text-foreground")
            }
            onClick={() => setChosen({ kind: "new" })}
          >
            <Icon name="Plus" className="size-3.5 shrink-0" />
            New thread
          </button>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={busy || nothingToSay}
          onClick={() => void submit()}
        >
          Submit review
        </Button>
        {nothingToSay ? (
          <span className="text-xs text-muted-foreground">
            A round needs at least one comment or an overall note.
          </span>
        ) : null}
        {sent ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Icon name="Check" className="size-3.5" />
            {sent}
          </span>
        ) : null}
      </div>
      {failure ? (
        <p className="mt-2 flex gap-2 text-sm text-destructive">
          <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" />
          <span>{failure}</span>
        </p>
      ) : null}
      {drafts.error ? (
        <p className="mt-2 text-sm text-destructive">{drafts.error}</p>
      ) : null}
    </section>
  );
}
