import type {
  ReviewFeedbackArtifact,
  ReviewVerdict,
  TaskArtifact,
} from "../../shared/contract.js";
import type { ReviewArtifact } from "./concern.js";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** What each verdict is called where a reader meets it. */
export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: "Approved",
  request_changes: "Changes requested",
  comment: "Commented",
};

export interface ReviewRound {
  review: ReviewArtifact;
  /** 1-based and oldest first: the number a reader would give this round. */
  number: number;
  /** The feedback that answered it — the newest, if it was answered twice. */
  answer: ReviewFeedbackArtifact | null;
}

/**
 * The task's reviews as a numbered series, oldest first.
 *
 * A round is answered when some `review_feedback` artifact cites it. That is
 * the only record of an answer, so it is also the only thing worth asking:
 * nothing on the review itself changes when someone replies to it.
 */
export function summariseReviewRounds(
  artifacts: readonly TaskArtifact[],
): ReviewRound[] {
  const feedback = artifacts.filter(
    (artifact): artifact is ReviewFeedbackArtifact =>
      artifact.kind === "review_feedback",
  );
  return artifacts
    .filter(
      (artifact): artifact is ReviewArtifact => artifact.kind === "review",
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((review, index) => ({
      review,
      number: index + 1,
      answer:
        feedback
          .filter((entry) => entry.metadata.reviewArtifactId === review.id)
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          )[0] ?? null,
    }));
}

/**
 * Which round the route opens on. A named artifact wins; otherwise the newest
 * round nobody has answered, because an unanswered review is the one still
 * asking something of the reader. With every round answered this is simply
 * the newest, which is what a reader arriving to re-read one expects.
 */
export function pickReviewRound(
  rounds: readonly ReviewRound[],
  artifactId: string | null,
): ReviewRound | null {
  if (artifactId !== null) {
    return rounds.find((round) => round.review.id === artifactId) ?? null;
  }
  const newestFirst = [...rounds].reverse();
  return newestFirst.find((round) => round.answer === null) ?? newestFirst[0] ?? null;
}

function VerdictBadge({ answer }: { answer: ReviewFeedbackArtifact | null }) {
  if (answer === null) {
    return (
      <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs font-semibold text-foreground">
        Unanswered
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-sm px-1.5 py-px text-2xs text-muted-foreground">
      {REVIEW_VERDICT_LABELS[answer.metadata.verdict]}
    </span>
  );
}

interface RoundSwitcherProps {
  rounds: readonly ReviewRound[];
  current: ReviewRound;
  onSelect: (round: ReviewRound) => void;
}

/** Which round is on screen, how many there are, and which still want an answer. */
export function RoundSwitcher({
  rounds,
  current,
  onSelect,
}: RoundSwitcherProps) {
  if (rounds.length <= 1) {
    return <VerdictBadge answer={current.answer} />;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Round {current.number} of {rounds.length}
          <VerdictBadge answer={current.answer} />
          <Icon name="ChevronDown" className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {[...rounds].reverse().map((round) => (
          <DropdownMenuItem
            key={round.review.id}
            onSelect={() => onSelect(round)}
          >
            <span className="min-w-0 truncate">Round {round.number}</span>
            <VerdictBadge answer={round.answer} />
            {round.review.id === current.review.id ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
