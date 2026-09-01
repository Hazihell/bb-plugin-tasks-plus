export interface PatchLineRange {
  startLine: number;
  endLine: number;
}

export interface SlicedUnifiedPatch {
  patch: string;
  keptHunks: number;
  totalHunks: number;
}

interface Hunk {
  start: number;
  end: number;
  newStart: number;
  newCount: number;
}

const hunkLinePattern = /^@@[^\r\n]*(?:\r?$)/gm;
const hunkHeaderPattern =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunk(line: string, start: number, end: number): Hunk | null {
  const header = hunkHeaderPattern.exec(line.replace(/\r$/, ""));
  if (!header) return null;

  return {
    start,
    end,
    newStart: Number(header[3]),
    newCount: header[4] === undefined ? 1 : Number(header[4]),
  };
}

function hunkIntersectsRange(hunk: Hunk, ranges: readonly PatchLineRange[]) {
  if (hunk.newCount === 0) return false;
  const newEnd = hunk.newStart + hunk.newCount - 1;
  return ranges.some(
    (range) =>
      hunk.newStart <= range.endLine && newEnd >= range.startLine,
  );
}

/** The renderer groups concerns by cited lines, so unrelated hunks must stay hidden. */
export function sliceUnifiedPatch(
  patch: string,
  ranges: readonly PatchLineRange[],
): SlicedUnifiedPatch {
  const matches = [...patch.matchAll(hunkLinePattern)];
  const hunks: Hunk[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const start = match.index;
    const end = matches[index + 1]?.index ?? patch.length;
    const hunk = parseHunk(match[0], start, end);
    if (!hunk) {
      return {
        patch,
        keptHunks: matches.length,
        totalHunks: matches.length,
      };
    }
    hunks.push(hunk);
  }

  if (hunks.length === 0 || ranges.length === 0) {
    return {
      patch,
      keptHunks: hunks.length,
      totalHunks: hunks.length,
    };
  }

  const preamble = patch.slice(0, hunks[0]!.start);
  const kept = hunks.filter((hunk) => hunkIntersectsRange(hunk, ranges));
  return {
    patch: preamble + kept.map((hunk) => patch.slice(hunk.start, hunk.end)).join(""),
    keptHunks: kept.length,
    totalHunks: hunks.length,
  };
}
