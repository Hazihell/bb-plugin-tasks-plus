import { useState } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { TaskArtifact } from "../../shared/contract.js";
import {
  orderArtifactsByKindThenNewest,
  TASK_ARTIFACT_KIND_LABELS,
} from "../../shared/artifact-manifest.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import {
  REVIEW_VERDICT_LABELS,
  summariseReviewRounds,
  type ReviewRound,
} from "../review/rounds.js";
import { attachmentDownloadUrl } from "./attachments.js";
import { formatRelativeTime } from "./meta.js";
import { Icon } from "@/components/ui/icon";

/**
 * One artifact as a collapsed row. Metadata stays out of the row on purpose —
 * the rich narrative renderer is a separate concern — so a record with no body
 * simply expands to nothing.
 */
function ArtifactRow({
  artifact,
  taskKey,
  unsentDrafts,
  round = null,
}: {
  artifact: TaskArtifact;
  taskKey: string;
  /** Comments written against this review and not yet submitted. */
  unsentDrafts: number;
  /**
   * Where this artifact sits in the series of reviews, when it is one. The
   * answer travels with it: a reader asking what became of a review is asking
   * about the review, not about a separate record filed elsewhere.
   */
  round?: ReviewRound | null;
}) {
  const [open, setOpen] = useState(false);
  const navigation = useTasksNavigation();
  const href = artifact.externalUrl
    ? artifact.externalUrl
    : artifact.attachmentId
      ? attachmentDownloadUrl(artifact.attachmentId)
      : null;

  return (
    <div className="border-b border-border-hairline">
      <div className="flex h-8 items-center gap-2 px-0.5 text-sm">
        <button
          type="button"
          aria-expanded={open}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left hover:bg-state-hover"
          onClick={() => setOpen((current) => !current)}
        >
          <Icon
            name={open ? "ChevronDown" : "ChevronRight"}
            className="size-3 shrink-0 text-muted-foreground"
          />
          <span className="shrink-0 rounded-sm bg-secondary px-1 py-px text-2xs font-semibold text-muted-foreground">
            {TASK_ARTIFACT_KIND_LABELS[artifact.kind]}
          </span>
          {round === null ? null : (
            <span className="shrink-0 text-2xs font-semibold text-muted-foreground">
              Round {round.number}
            </span>
          )}
          <span className="min-w-0 truncate">{artifact.title}</span>
          <time className="shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(artifact.createdAt)}
          </time>
        </button>
        {round === null ? null : (
          <span
            className={
              round.answer === null
                ? "shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs font-semibold text-foreground"
                : "shrink-0 rounded-sm px-1.5 py-px text-2xs text-muted-foreground"
            }
          >
            {round.answer === null
              ? "Unanswered"
              : REVIEW_VERDICT_LABELS[round.answer.metadata.verdict]}
          </span>
        )}
        {unsentDrafts > 0 ? (
          <span
            className="shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs font-semibold text-foreground"
            title="Comments you have not submitted yet"
          >
            {unsentDrafts} unsent
          </span>
        ) : null}
        {artifact.kind === "review" ? (
          <button
            type="button"
            aria-label={`Open review ${artifact.title}`}
            className="shrink-0 rounded-sm px-1 py-px text-2xs font-semibold text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={() =>
              navigation.go({
                kind: "review",
                taskKey,
                artifactId: artifact.id,
              })
            }
          >
            Open review
          </button>
        ) : null}
        {href ? (
          <UrlLink
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${artifact.title}`}
            className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
          >
            <Icon name="ArrowUpRight" className="size-3.5" />
          </UrlLink>
        ) : null}
      </div>
      {open ? (
        <div className="pb-2 pl-5 pr-1">
          <TasksEditor
            value={artifact.body ?? ""}
            onChange={() => {}}
            readOnly
            variant="comment"
          />
          {round?.answer ? (
            <div className="mt-2 border-l-2 border-border pl-2">
              <div className="text-2xs font-semibold text-muted-foreground">
                Your answer ·{" "}
                {REVIEW_VERDICT_LABELS[round.answer.metadata.verdict]} ·{" "}
                {round.answer.metadata.comments.length}{" "}
                {round.answer.metadata.comments.length === 1
                  ? "comment"
                  : "comments"}
              </div>
              <TasksEditor
                value={round.answer.metadata.summary}
                onChange={() => {}}
                readOnly
                variant="comment"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The task's engineering record, grouped by kind and newest first — the same
 *  order the seed prompt's manifest uses. Read-only: artifacts are written by
 *  agents through the CLI, so there is no add or delete affordance here. */
export function ArtifactsSection({
  artifacts,
  taskId,
  taskKey,
}: {
  artifacts: TaskArtifact[];
  taskId: string;
  taskKey: string;
}) {
  // One count per review, fetched apart from the artifacts themselves: an
  // unsent comment is the reader's own state, not the task's record. A
  // failure here simply leaves the badges off.
  const drafts = useTasksQuery(
    async (query) => (await query.call("countReviewDrafts", { taskId })).counts,
    ["tasks:changed"],
    [taskId],
  );
  const unsentByReview = new Map(
    (drafts.data ?? []).map((entry) => [entry.reviewArtifactId, entry.count]),
  );
  // An answer is not a peer of the review it answers; it is what happened to
  // it. Every answer that found its review is shown on that review's row, so
  // only an orphan — a review since deleted — is left to stand on its own.
  const rounds = summariseReviewRounds(artifacts);
  const roundByReview = new Map(rounds.map((round) => [round.review.id, round]));
  const answered = new Set(
    rounds.flatMap((round) => (round.answer ? [round.answer.id] : [])),
  );
  const listed = artifacts.filter((artifact) => !answered.has(artifact.id));
  if (listed.length === 0) return null;
  return (
    <section className="mt-6">
      <div className="mb-2 pt-1.5 text-xs font-semibold text-muted-foreground">
        Artifacts
      </div>
      {orderArtifactsByKindThenNewest(listed).map((artifact) => (
        <ArtifactRow
          key={artifact.id}
          artifact={artifact}
          taskKey={taskKey}
          unsentDrafts={unsentByReview.get(artifact.id) ?? 0}
          round={roundByReview.get(artifact.id) ?? null}
        />
      ))}
    </section>
  );
}
