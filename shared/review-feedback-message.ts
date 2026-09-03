import type {
  ReviewFeedbackComment,
  ReviewVerdict,
} from "./contract.js";

export interface ReviewFeedbackMessageInput {
  taskKey: string;
  reviewTitle: string;
  baseRef: string;
  headSha: string;
  verdict: ReviewVerdict;
  summary: string;
  comments: readonly ReviewFeedbackComment[];
}

function quoteFence(lines: readonly string[]): string {
  const longestRun = lines.reduce((longest, line) => {
    const runs = line.match(/`+/g) ?? [];
    return Math.max(longest, ...runs.map((run) => run.length));
  }, 0);
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}diff\n${lines.join("\n")}\n${fence}`;
}

function formatComment(comment: ReviewFeedbackComment, index: number): string {
  if (comment.anchor === "file") {
    return (
      `### Comment ${index}\n\n` +
      `- File: ${comment.path}\n\n` +
      `${comment.body}`
    );
  }

  return (
    `### Comment ${index}\n\n` +
    `- File: ${comment.path}\n` +
    `- Diff side: ${comment.side}\n` +
    `- Line range: ${comment.startLine}-${comment.endLine}\n\n` +
    "Selected diff lines (verbatim; no surrounding context):\n\n" +
    `${quoteFence(comment.quotedLines)}\n\n` +
    `${comment.body}`
  );
}

export function formatReviewFeedbackMessage(
  input: ReviewFeedbackMessageInput,
): string {
  const comments =
    input.comments.length === 0
      ? "No line or file comments were left."
      : input.comments
          .map((comment, index) => formatComment(comment, index + 1))
          .join("\n\n");
  const summary = input.summary === "" ? "No summary was provided." : input.summary;
  // A round asks the reviewer to read something they have not read. Naming the
  // sha they stopped at is what makes the next review only the new work: the
  // agent has no other way to know where the last round's reading ended.
  const followUp =
    input.verdict === "request_changes"
      ? `\n\nWhen this work is done, write a fresh narrative review artifact on task ${input.taskKey} so the reviewer can do another round. Set its \`baseRef\` to \`${input.headSha}\` — the sha reviewed above — so the new review covers only the changes you made in response to this feedback. Do not re-describe the work already reviewed.`
      : "";

  return (
    `# Review feedback for ${input.taskKey}\n\n` +
    `Review: ${input.reviewTitle}\n` +
    `Base ref: ${input.baseRef}\n` +
    `Reviewed head: ${input.headSha}\n` +
    `Verdict: ${input.verdict}\n\n` +
    `## Summary\n\n${summary}\n\n` +
    `## Comments\n\n${comments}${followUp}`
  );
}
