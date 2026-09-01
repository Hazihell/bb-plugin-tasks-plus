/**
 * The side of a diff a line lives on. Named the way the renderer names it, so
 * a selection can be carried across this seam without translation.
 */
export type PatchSide = "additions" | "deletions";

/**
 * A selection as the renderer reports it: two line numbers, each with the side
 * its number counts on. The side is optional because a click on a context line
 * belongs to both sides at once.
 *
 * Structurally the renderer's own `SelectedLineRange`, restated here so this
 * module — and its test — need nothing but strings and numbers.
 */
export interface PatchSelectionRange {
  start: number;
  side?: PatchSide;
  end: number;
  endSide?: PatchSide;
}

/** Where a comment points, in the shape the contract stores it. */
export interface PatchSelectionAnchor {
  path: string;
  side: PatchSide;
  startLine: number;
  endLine: number;
  quotedLines: string[];
}

interface PatchRow {
  /** The line verbatim, prefix included, newline stripped. */
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const hunkHeaderPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripLineEnding(line: string): string {
  return line.replace(/\r$/, "");
}

/**
 * Every line the renderer draws, in the order it draws them. Hunk headers and
 * the file preamble are not selectable and so are not rows; keeping them out
 * makes a row's position in this list the same index the renderer selects by.
 */
function readPatchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const line = stripLineEnding(raw);
    const header = hunkHeaderPattern.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    // "\ No newline at end of file" annotates the line above it rather than
    // being one, and the preamble is not part of any hunk.
    if (!inHunk || line.startsWith("\\")) continue;

    if (line.startsWith("-")) {
      rows.push({ text: line, oldLine, newLine: null });
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ text: line, oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ text: line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // A blank final line is the trailing newline, not a row; anything else
    // here is a second file's preamble, which ends this file's hunks.
    if (line.length === 0) continue;
    inHunk = false;
  }

  return rows;
}

function rowIndexAt(
  rows: readonly PatchRow[],
  lineNumber: number,
  side: PatchSide | undefined,
): number | null {
  // An unsided point came from a context line, which carries a number on both
  // sides. Additions first: it is the side the reader is looking at.
  const sides: PatchSide[] =
    side === undefined ? ["additions", "deletions"] : [side];
  for (const candidate of sides) {
    const index = rows.findIndex((row) =>
      candidate === "additions"
        ? row.newLine === lineNumber
        : row.oldLine === lineNumber,
    );
    if (index !== -1) return index;
  }
  return null;
}

/** Answers "does this patch draw that line?" without re-reading the patch. */
export type PatchLineDrawer = (side: PatchSide, lineNumber: number) => boolean;

/**
 * Read one patch, then answer for any number of lines.
 *
 * A comment is shown where its lines are shown, and a review's patches are
 * sliced per concern, so the same file can be on screen twice with only one
 * of the two showing the line — which is a question asked once per comment,
 * over a patch that does not change between the asking.
 */
export function patchLineDrawer(patch: string): PatchLineDrawer {
  const drawn = new Set<string>();
  for (const row of readPatchRows(patch)) {
    if (row.newLine !== null) drawn.add(`additions:${row.newLine}`);
    if (row.oldLine !== null) drawn.add(`deletions:${row.oldLine}`);
  }
  return (side, lineNumber) => drawn.has(`${side}:${lineNumber}`);
}

/**
 * Turn a selection over a rendered patch into the anchor a comment is stored
 * with.
 *
 * The anchor names one side, because the reader of the feedback has to know
 * whether the numbers point into the current file or into a file that no
 * longer has those lines. A selection that touched anything still present is
 * an `additions` anchor; only a selection made entirely of removed lines
 * points at `deletions`.
 *
 * Returns null when the selection resolves to nothing — a range against a
 * patch that has since been re-sliced, most likely — because a comment with
 * no lines under it is worse than no comment at all.
 */
export function anchorFromPatchSelection(
  path: string,
  patch: string,
  range: PatchSelectionRange,
): PatchSelectionAnchor | null {
  const rows = readPatchRows(patch);
  const startIndex = rowIndexAt(rows, range.start, range.side);
  const endIndex = rowIndexAt(rows, range.end, range.endSide ?? range.side);
  if (startIndex === null || endIndex === null) return null;

  const selected = rows.slice(
    Math.min(startIndex, endIndex),
    Math.max(startIndex, endIndex) + 1,
  );
  if (selected.length === 0) return null;

  const numbers = selected
    .map((row) => row.newLine)
    .filter((line): line is number => line !== null);
  const side: PatchSide = numbers.length > 0 ? "additions" : "deletions";
  const lines =
    side === "additions"
      ? numbers
      : selected
          .map((row) => row.oldLine)
          .filter((line): line is number => line !== null);
  if (lines.length === 0) return null;

  return {
    path,
    side,
    startLine: Math.min(...lines),
    endLine: Math.max(...lines),
    quotedLines: selected.map((row) => row.text),
  };
}
