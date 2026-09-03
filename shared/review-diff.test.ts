import { describe, expect, it } from "vitest";
import { isReviewStale, reviewConcernPaths } from "./review-diff.js";

describe("review diff helpers", () => {
  it("deduplicates concern paths in first-appearance order", () => {
    expect(
      reviewConcernPaths({
        concerns: [
          {
            hunks: [
              { path: "api/index.ts" },
              { path: "shared/contract.ts" },
            ],
          },
          {
            hunks: [
              { path: "api/index.ts" },
              { path: "views/review/index.tsx" },
            ],
          },
        ],
      }),
    ).toEqual([
      "api/index.ts",
      "shared/contract.ts",
      "views/review/index.tsx",
    ]);
  });

  it("reports equal heads as current and different heads as stale", () => {
    expect(isReviewStale("abc123", "abc123")).toBe(false);
    expect(isReviewStale("abc123", "def456")).toBe(true);
  });

  it("does not claim staleness when the current head is unknown", () => {
    expect(isReviewStale("abc123", null)).toBe(false);
  });
});
