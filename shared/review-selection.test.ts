import { describe, expect, it } from "vitest";
import {
  anchorFromPatchSelection,
  patchLineDrawer,
} from "./review-selection.js";

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,4 +1,4 @@
 const first = true;
-const changed = false;
-const alsoChanged = false;
+const changed = true;
+const alsoChanged = true;
 const afterFirst = true;
@@ -10,2 +10,3 @@
 const beforeSecond = true;
+const added = true;
 const afterSecond = true;
`;

describe("anchorFromPatchSelection", () => {
  it("quotes added lines with their prefix and numbers them on the new side", () => {
    const anchor = anchorFromPatchSelection("src/example.ts", patch, {
      start: 11,
      side: "additions",
      end: 11,
      endSide: "additions",
    });

    expect(anchor).toEqual({
      path: "src/example.ts",
      side: "additions",
      startLine: 11,
      endLine: 11,
      quotedLines: ["+const added = true;"],
    });
  });

  it("anchors a selection of only removed lines to the deletions side", () => {
    const anchor = anchorFromPatchSelection("src/example.ts", patch, {
      start: 2,
      side: "deletions",
      end: 3,
      endSide: "deletions",
    });

    expect(anchor).toEqual({
      path: "src/example.ts",
      side: "deletions",
      startLine: 2,
      endLine: 3,
      quotedLines: ["-const changed = false;", "-const alsoChanged = false;"],
    });
  });

  it("takes every rendered line between the two ends, both sides included", () => {
    const anchor = anchorFromPatchSelection("src/example.ts", patch, {
      start: 2,
      side: "deletions",
      end: 3,
      endSide: "additions",
    });

    // The removed lines are quoted, but the range still points at the new
    // side: something the reader can still open the file and find.
    expect(anchor).toEqual({
      path: "src/example.ts",
      side: "additions",
      startLine: 2,
      endLine: 3,
      quotedLines: [
        "-const changed = false;",
        "-const alsoChanged = false;",
        "+const changed = true;",
        "+const alsoChanged = true;",
      ],
    });
  });

  it("reads a context line's number on the additions side when no side is given", () => {
    const anchor = anchorFromPatchSelection("src/example.ts", patch, {
      start: 1,
      end: 1,
    });

    expect(anchor).toEqual({
      path: "src/example.ts",
      side: "additions",
      startLine: 1,
      endLine: 1,
      quotedLines: [" const first = true;"],
    });
  });

  it("selects backwards the same way it selects forwards", () => {
    const forwards = anchorFromPatchSelection("src/example.ts", patch, {
      start: 10,
      side: "additions",
      end: 12,
      endSide: "additions",
    });
    const backwards = anchorFromPatchSelection("src/example.ts", patch, {
      start: 12,
      side: "additions",
      end: 10,
      endSide: "additions",
    });

    expect(backwards).toEqual(forwards);
    expect(forwards?.quotedLines).toEqual([
      " const beforeSecond = true;",
      "+const added = true;",
      " const afterSecond = true;",
    ]);
  });

  it("crosses a hunk boundary rather than reporting the gap as selected", () => {
    const anchor = anchorFromPatchSelection("src/example.ts", patch, {
      start: 4,
      side: "additions",
      end: 10,
      endSide: "additions",
    });

    // Nothing between the hunks is rendered, so nothing between them is
    // quoted; the line numbers still bound what the reader dragged over.
    expect(anchor?.quotedLines).toEqual([
      " const afterFirst = true;",
      " const beforeSecond = true;",
    ]);
    expect(anchor?.startLine).toBe(4);
    expect(anchor?.endLine).toBe(10);
  });

  it("keeps a line that carries no newline at the end of the file", () => {
    const trailing = `--- a/src/tail.ts
+++ b/src/tail.ts
@@ -1,1 +1,1 @@
-const tail = 1;
\\ No newline at end of file
+const tail = 2;
\\ No newline at end of file
`;

    const anchor = anchorFromPatchSelection("src/tail.ts", trailing, {
      start: 1,
      side: "deletions",
      end: 1,
      endSide: "deletions",
    });

    expect(anchor?.quotedLines).toEqual(["-const tail = 1;"]);
  });

  it("declines a selection that resolves to no rendered line", () => {
    expect(
      anchorFromPatchSelection("src/example.ts", patch, {
        start: 900,
        side: "additions",
        end: 901,
        endSide: "additions",
      }),
    ).toBeNull();
  });

  it("declines when the patch has no hunks at all", () => {
    expect(
      anchorFromPatchSelection("src/example.ts", "", {
        start: 1,
        end: 1,
      }),
    ).toBeNull();
  });

  it("reads a patch with carriage returns without carrying them into the quote", () => {
    const crlf = patch.split("\n").join("\r\n");

    const anchor = anchorFromPatchSelection("src/example.ts", crlf, {
      start: 11,
      side: "additions",
      end: 11,
      endSide: "additions",
    });

    expect(anchor?.quotedLines).toEqual(["+const added = true;"]);
  });
});

describe("patchLineDrawer", () => {
  it("answers for every line of a patch it read once", () => {
    const draws = patchLineDrawer(patch);

    expect(draws("additions", 11)).toBe(true);
    expect(draws("deletions", 2)).toBe(true);
    // The same reading answers the lines the slice left out.
    expect(draws("additions", 7)).toBe(false);
    expect(draws("deletions", 7)).toBe(false);
  });

  it("draws a context line on both sides at once", () => {
    const draws = patchLineDrawer(patch);

    expect(draws("additions", 10)).toBe(true);
    expect(draws("deletions", 10)).toBe(true);
  });
});
