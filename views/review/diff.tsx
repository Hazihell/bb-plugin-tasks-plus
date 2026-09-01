import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { FileDiffMetadata, ThemesType } from "@pierre/diffs";
import {
  sliceUnifiedPatch,
  type PatchLineRange,
} from "../../shared/patch-slice.js";

/**
 * The host publishes the code themes it renders its own diffs with on the
 * document element; a surface that reads them stays in step with the app's
 * appearance setting without owning a theme of its own.
 */
function hostCodeTheme(): ThemesType | undefined {
  if (typeof document === "undefined") return undefined;
  const { bbCodeThemeDark: dark, bbCodeThemeLight: light } =
    document.documentElement.dataset;
  if (dark === undefined || light === undefined) return undefined;
  return { dark, light };
}

interface ConcernDiffProps {
  path: string;
  /** The whole-file patch as the host produced it. */
  patch: string;
  /** New-side line ranges this concern cites; empty keeps the whole patch. */
  ranges: readonly PatchLineRange[];
  /** The host cut the patch short (a very large file). */
  truncated?: boolean;
}

/**
 * One file's contribution to one concern: the patch narrowed to the lines the
 * concern cites. Everything this drops is said out loud — a reader must be
 * able to tell a small change from a small view of a large one.
 */
export function ConcernDiff({
  path,
  patch,
  ranges,
  truncated = false,
}: ConcernDiffProps) {
  const sliced = useMemo(
    () => sliceUnifiedPatch(patch, ranges),
    [patch, ranges],
  );
  const file = useMemo((): FileDiffMetadata | null => {
    try {
      return (
        parsePatchFiles(sliced.patch).flatMap((parsed) => parsed.files)[0] ??
        null
      );
    } catch {
      // A patch this renderer cannot read is still a patch the reader can.
      return null;
    }
  }, [sliced.patch]);
  const theme = hostCodeTheme();
  const droppedHunks = sliced.totalHunks - sliced.keptHunks;

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border-hairline bg-card px-3 py-1.5">
        <span className="font-mono text-xs">{path}</span>
        {droppedHunks > 0 ? (
          <span className="text-2xs text-muted-foreground">
            {droppedHunks} other {droppedHunks === 1 ? "hunk" : "hunks"} in this
            file are not part of this concern
          </span>
        ) : null}
        {truncated ? (
          <span className="text-2xs text-muted-foreground">
            the host truncated this patch
          </span>
        ) : null}
      </div>
      {file ? (
        <FileDiff
          fileDiff={file}
          options={{
            diffStyle: "unified",
            stickyHeader: false,
            disableFileHeader: true,
            ...(theme === undefined ? {} : { theme }),
          }}
        />
      ) : (
        // Unhighlighted, but complete: better a plain patch than a blank box.
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
          {sliced.patch}
        </pre>
      )}
    </div>
  );
}
