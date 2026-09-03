import { describe, expect, it } from "vitest";
import { formatReviewFeedbackMessage } from "./review-feedback-message.js";

const baseInput = {
  taskKey: "APP-17",
  reviewTitle: "Narrative review",
  baseRef: "main",
  headSha: "abc123",
  summary: "Please address the data-loss path.",
  comments: [
    {
      anchor: "lines" as const,
      path: "src/save.ts",
      side: "additions" as const,
      startLine: 12,
      endLine: 13,
      quotedLines: ["+  await save(input);", "+  return result;"],
      body: "This returns before the transaction is durable.",
    },
    {
      anchor: "file" as const,
      path: "src/telemetry.ts",
      body: "Please add coverage for the retry path.",
    },
  ],
};

describe("formatReviewFeedbackMessage", () => {
  it("carries each comment's complete anchor and only the selected lines", () => {
    const message = formatReviewFeedbackMessage({
      ...baseInput,
      verdict: "comment",
    });

    expect(message).toContain("# Review feedback for APP-17");
    expect(message).toContain("Review: Narrative review");
    expect(message).toContain("Base ref: main");
    expect(message).toContain("Reviewed head: abc123");
    expect(message).toContain("- File: src/save.ts");
    expect(message).toContain("- Diff side: additions");
    expect(message).toContain("- Line range: 12-13");
    expect(message).toContain("+  await save(input);\n+  return result;");
    expect(message).not.toContain("context before save");
    expect(message).toContain("- File: src/telemetry.ts");
    const fileComment = message.slice(message.indexOf("### Comment 2"));
    expect(fileComment).not.toContain("Diff side:");
    expect(fileComment).not.toContain("Line range:");
    expect(message).toContain("Please add coverage for the retry path.");
  });

  it("adds the next-round instruction only for request_changes", () => {
    const requestChanges = formatReviewFeedbackMessage({
      ...baseInput,
      verdict: "request_changes",
    });
    const comment = formatReviewFeedbackMessage({
      ...baseInput,
      verdict: "comment",
    });
    const approve = formatReviewFeedbackMessage({
      ...baseInput,
      verdict: "approve",
    });

    const instruction =
      "write a fresh narrative review artifact on task APP-17";
    expect(requestChanges).toContain(instruction);
    expect(comment).not.toContain(instruction);
    expect(approve).not.toContain(instruction);
    // And the next round starts where this one stopped reading, so it covers
    // only the work done in answer to it.
    expect(requestChanges).toContain(`\`baseRef\` to \`${baseInput.headSha}\``);
  });

  it("keeps markdown fences safe when a selected line contains backticks", () => {
    const message = formatReviewFeedbackMessage({
      ...baseInput,
      verdict: "comment",
      comments: [
        {
          anchor: "lines",
          path: "src/template.ts",
          side: "deletions",
          startLine: 4,
          endLine: 4,
          quotedLines: ["-const fence = ` ``` `;"],
          body: "The template marker is part of the deleted line.",
        },
      ],
    });

    expect(message).toContain("-const fence = ` ``` `;");
    expect(message).toContain("````diff");
    expect(message).toContain("````\n\nThe template marker");
  });
});
