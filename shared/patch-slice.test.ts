import { describe, expect, it } from "vitest";
import { sliceUnifiedPatch } from "./patch-slice.js";

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 const first = true;
-const changed = false;
+const changed = true;
 const afterFirst = true;
@@ -10,2 +10,3 @@
 const beforeSecond = true;
+const added = true;
 const afterSecond = true;
@@ -20,2 +20,2 @@
 const beforeThird = true;
-const removed = true;
+const replacement = true;
`;

describe("sliceUnifiedPatch", () => {
  it("keeps only the hunk intersecting a requested new-side range", () => {
    const result = sliceUnifiedPatch(patch, [{ startLine: 11, endLine: 11 }]);

    expect(result).toEqual({
      patch: `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -10,2 +10,3 @@
 const beforeSecond = true;
+const added = true;
 const afterSecond = true;
`,
      keptHunks: 1,
      totalHunks: 3,
    });
  });

  it("keeps two hunks when the range spans both", () => {
    const result = sliceUnifiedPatch(patch, [{ startLine: 2, endLine: 12 }]);

    expect(result.patch).toBe(`diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 const first = true;
-const changed = false;
+const changed = true;
 const afterFirst = true;
@@ -10,2 +10,3 @@
 const beforeSecond = true;
+const added = true;
 const afterSecond = true;
`);
    expect(result.keptHunks).toBe(2);
    expect(result.totalHunks).toBe(3);
  });

  it("keeps the file preamble and no hunks when nothing matches", () => {
    const result = sliceUnifiedPatch(patch, [{ startLine: 50, endLine: 60 }]);

    expect(result).toEqual({
      patch: `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
`,
      keptHunks: 0,
      totalHunks: 3,
    });
  });

  it("keeps every hunk when ranges are empty", () => {
    expect(sliceUnifiedPatch(patch, [])).toEqual({
      patch,
      keptHunks: 3,
      totalHunks: 3,
    });
  });

  it("treats a hunk header without a count as a one-line span", () => {
    const oneLinePatch = `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-before
+after
@@ -8,2 +8,2 @@
 before
-old
+new
`;

    expect(
      sliceUnifiedPatch(oneLinePatch, [{ startLine: 1, endLine: 1 }]),
    ).toEqual({
      patch: `--- a/file.ts
+++ b/file.ts
@@ -1 +1 @@
-before
+after
`,
      keptHunks: 1,
      totalHunks: 2,
    });
  });

  it("passes garbage through unchanged with equal hunk counts", () => {
    const garbage = "not a unified patch";

    expect(sliceUnifiedPatch(garbage, [{ startLine: 1, endLine: 1 }])).toEqual({
      patch: garbage,
      keptHunks: 0,
      totalHunks: 0,
    });
  });
});
