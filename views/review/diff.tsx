import { useMemo, useState } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type {
  DiffLineAnnotation,
  FileDiffMetadata,
  FileDiffOptions,
  SelectedLineRange,
  ThemesType,
} from "@pierre/diffs";
import type {
  ReviewDraftAnchor,
  ReviewDraftComment,
} from "../../shared/contract.js";
import {
  sliceUnifiedPatch,
  type PatchLineRange,
} from "../../shared/patch-slice.js";
import {
  anchorFromPatchSelection,
  patchLineDrawer,
  type PatchSide,
} from "../../shared/review-selection.js";
import { useDiffWordWrap } from "../../shell/diff-preference.js";
import { CommentComposer, DraftCommentCard } from "./comment.js";
import { Icon } from "@/components/ui/icon";

/**
 * The host publishes the code themes it renders its own diffs with on the
 * document element; a surface that reads them stays in step with the app's
 * appearance setting without owning a theme of its own.
 *
 * The pair is handed on as one object with the identity of its two names, not
 * of the read: everything the renderer is configured with hangs off it, and a
 * fresh object every render would rebuild that configuration every render.
 */
export function useHostCodeTheme(): ThemesType | undefined {
  const names =
    typeof document === "undefined"
      ? undefined
      : document.documentElement.dataset;
  const dark = names?.bbCodeThemeDark;
  const light = names?.bbCodeThemeLight;
  return useMemo(
    () =>
      dark === undefined || light === undefined ? undefined : { dark, light },
    [dark, light],
  );
}

/** How a comment box says what it is attached to. */
function anchorContext(anchor: ReviewDraftAnchor): string {
  if (anchor.anchor === "file") return anchor.path;
  const lines =
    anchor.startLine === anchor.endLine
      ? `${anchor.startLine}`
      : `${anchor.startLine}-${anchor.endLine}`;
  return `${anchor.path}:${lines} (${anchor.side === "deletions" ? "removed" : "added"})`;
}

/** Where the renderer hangs a row: one side of one line. */
function annotationKey(side: PatchSide, lineNumber: number): string {
  return `${side}:${lineNumber}`;
}

function lineAnchorKey(comment: ReviewDraftComment): string | null {
  return comment.anchor.anchor === "lines"
    ? annotationKey(comment.anchor.side, comment.anchor.endLine)
    : null;
}

export interface ReviewCommentActions {
  save: (input: {
    id?: string | null;
    anchor: ReviewDraftAnchor;
    body: string;
  }) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

interface ConcernDiffProps {
  path: string;
  /** The whole-file patch as the host produced it. */
  patch: string;
  /** New-side line ranges this concern cites; empty keeps the whole patch. */
  ranges: readonly PatchLineRange[];
  /** The host cut the patch short (a very large file). */
  truncated?: boolean;
  /** Every unsent comment on the review; this card shows the ones it draws. */
  comments: readonly ReviewDraftComment[];
  /**
   * Whether remarks about the file as a whole belong to this card. False on
   * every card but the first for a given file, so a file cited by two
   * concerns still has one place its remarks are written and read.
   */
  ownsFileComments: boolean;
  actions: ReviewCommentActions;
}

/**
 * One file's contribution to one concern: the patch narrowed to the lines the
 * concern cites, with the reader's own comments where they were left.
 * Everything this drops is said out loud — a reader must be able to tell a
 * small change from a small view of a large one.
 *
 * A line comment appears wherever its lines appear. The same file can sit
 * under two concerns, so this card claims the comments it can actually draw
 * and leaves the rest to whichever card draws them. A remark about the file
 * as a whole has no lines to follow, so it belongs to one card only and is
 * told which by whoever laid the cards out.
 */
export function ConcernDiff({
  path,
  patch,
  ranges,
  truncated = false,
  comments,
  ownsFileComments,
  actions,
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
  const theme = useHostCodeTheme();
  const [wrap] = useDiffWordWrap();
  const droppedHunks = sliced.totalHunks - sliced.keptHunks;

  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  // The box being written, if any. One at a time per card: a second box would
  // have no line to sit under that the first is not already using.
  const [composer, setComposer] = useState<ReviewDraftAnchor | null>(null);

  const fileComments = ownsFileComments
    ? comments.filter(
        (comment) =>
          comment.anchor.anchor === "file" && comment.anchor.path === path,
      )
    : [];
  // Read the patch once and ask it about each comment, rather than reading it
  // again for every comment the review carries.
  const drawsLine = useMemo(
    () => patchLineDrawer(sliced.patch),
    [sliced.patch],
  );
  const lineComments = comments.filter(
    (comment) =>
      comment.anchor.anchor === "lines" &&
      comment.anchor.path === path &&
      drawsLine(comment.anchor.side, comment.anchor.endLine),
  );

  const composerKey =
    composer !== null && composer.anchor === "lines"
      ? annotationKey(composer.side, composer.endLine)
      : null;
  // One row per annotated line however many comments hang on it; the renderer
  // compares these by value, so rebuilding the array each render costs nothing.
  const annotations = new Map<string, DiffLineAnnotation<undefined>>();
  for (const comment of lineComments) {
    if (comment.anchor.anchor !== "lines") continue;
    annotations.set(annotationKey(comment.anchor.side, comment.anchor.endLine), {
      side: comment.anchor.side,
      lineNumber: comment.anchor.endLine,
    });
  }
  if (composer !== null && composer.anchor === "lines") {
    annotations.set(annotationKey(composer.side, composer.endLine), {
      side: composer.side,
      lineNumber: composer.endLine,
    });
  }

  const closeComposer = () => {
    setComposer(null);
    setSelection(null);
  };

  const options = useMemo(
    (): FileDiffOptions<undefined> => ({
      diffStyle: "unified",
      stickyHeader: false,
      disableFileHeader: true,
      overflow: wrap ? "wrap" : "scroll",
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: "number",
      // The gutter control is the whole affordance: it opens the box for
      // whatever is selected, with nothing to choose in between.
      onGutterUtilityClick: (range: SelectedLineRange) => {
        setSelection(range);
        const anchor = anchorFromPatchSelection(path, sliced.patch, range);
        if (anchor === null) return;
        setComposer({ anchor: "lines", ...anchor });
      },
      onLineSelectionStart: setSelection,
      onLineSelectionChange: setSelection,
      onLineSelectionEnd: setSelection,
      ...(theme === undefined ? {} : { theme }),
    }),
    [wrap, theme, path, sliced.patch],
  );

  const renderAnnotation = (annotation: DiffLineAnnotation<undefined>) => {
    const key = annotationKey(annotation.side, annotation.lineNumber);
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        {lineComments
          .filter((comment) => lineAnchorKey(comment) === key)
          .map((comment) => (
            <DraftCommentCard
              key={comment.id}
              comment={comment}
              onSave={(body) =>
                actions.save({ id: comment.id, anchor: comment.anchor, body })
              }
              onDelete={() => actions.remove(comment.id)}
            />
          ))}
        {composerKey === key && composer !== null ? (
          <CommentComposer
            context={anchorContext(composer)}
            submitLabel="Add comment"
            onSubmit={(body) => actions.save({ anchor: composer, body })}
            onCancel={closeComposer}
          />
        ) : null}
      </div>
    );
  };

  return (
    // The host opens its sidebar on a rightward swipe unless the gesture
    // starts inside something that scrolls sideways. It cannot see into the
    // diff's own scroller, so a touch drag across a hunk would open the
    // sidebar instead of panning the code. Claim the gesture while the code
    // can scroll; hand it back once wrapping means there is nowhere to pan.
    <div
      // Not `overflow-hidden`: the header below sticks to the route's scroll
      // area, and any overflow here would make it stick to this box instead.
      className="mt-3 rounded-md border border-border"
      {...(wrap ? {} : { "data-no-sidebar-swipe": "" })}
    >
      <div
        // Directly under the document's toolbar, and clipped by this card, so
        // the file name follows its own patch and no further.
        className="sticky top-10 z-10 flex flex-col gap-y-0.5 rounded-t-md border-b border-border-hairline bg-card px-3 py-1.5"
      >
        {/* The name and the button share a row of their own. What the card had
            to leave out is said underneath: a note long enough to wrap must
            not be able to carry the button off the header with it. */}
        <div className="flex items-baseline gap-x-3">
          <span className="min-w-0 truncate font-mono text-xs">{path}</span>
          {/* Only where such a remark would then be shown: a box that writes
              into another card is worse than no box. */}
          {ownsFileComments ? (
            <button
              type="button"
              aria-label={`Comment on ${path}`}
              className="ml-auto flex shrink-0 items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
              onClick={() => setComposer({ anchor: "file", path })}
            >
              <Icon name="MessageSquarePlus" className="size-3.5" />
              Comment on file
            </button>
          ) : null}
        </div>
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
      {fileComments.length > 0 || composer?.anchor === "file" ? (
        <div className="flex flex-col gap-2 border-b border-border-hairline px-3 py-2">
          {fileComments.map((comment) => (
            <DraftCommentCard
              key={comment.id}
              comment={comment}
              onSave={(body) =>
                actions.save({ id: comment.id, anchor: comment.anchor, body })
              }
              onDelete={() => actions.remove(comment.id)}
            />
          ))}
          {composer?.anchor === "file" ? (
            <CommentComposer
              context={anchorContext(composer)}
              submitLabel="Add comment"
              onSubmit={(body) => actions.save({ anchor: composer, body })}
              onCancel={closeComposer}
            />
          ) : null}
        </div>
      ) : null}
      {/* Rounding the card's bottom corners is this wrapper's whole job; the
          header above must stay outside any clipping box to keep sticking. */}
      <div className="overflow-hidden rounded-b-md">
        {file ? (
          <FileDiff<undefined>
            fileDiff={file}
            options={options}
            selectedLines={selection}
            lineAnnotations={[...annotations.values()]}
            renderAnnotation={renderAnnotation}
          />
        ) : (
          // Unhighlighted, but complete: better a plain patch than a blank box.
          <pre
            className={
              wrap
                ? "whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed"
                : "overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed"
            }
          >
            {sliced.patch}
          </pre>
        )}
      </div>
      {/* With no rendered diff there are no lines to hang a comment under, so
          the ones this card claimed are listed rather than lost. */}
      {file === null && lineComments.length > 0 ? (
        <div className="flex flex-col gap-2 border-t border-border-hairline px-3 py-2">
          {lineComments.map((comment) => (
            <DraftCommentCard
              key={comment.id}
              comment={comment}
              onSave={(body) =>
                actions.save({ id: comment.id, anchor: comment.anchor, body })
              }
              onDelete={() => actions.remove(comment.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
