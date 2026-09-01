import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReviewDraftAnchor,
  ReviewDraftComment,
} from "../../shared/contract.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";

/** Long enough that a sentence is one save, short enough to survive a reload. */
const SUMMARY_SAVE_DELAY_MS = 600;

export interface ReviewDraftStore {
  comments: readonly ReviewDraftComment[];
  /** The overall note as the reviewer is typing it, not as last saved. */
  summary: string;
  /** Still fetching the drafts for the first time. */
  isLoading: boolean;
  /** The last write that failed, in the reviewer's terms. Null when clear. */
  error: string | null;
  setSummary: (body: string) => void;
  /** Save whatever is typed now, without waiting for the debounce. */
  flushSummary: () => Promise<void>;
  /** Forget the locally typed note and show the server's again. */
  resetSummary: () => void;
  saveComment: (input: {
    id?: string | null;
    anchor: ReviewDraftAnchor;
    body: string;
  }) => Promise<boolean>;
  deleteComment: (id: string) => Promise<boolean>;
  refresh: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every unsent comment on one review, plus its overall note.
 *
 * The server is the only copy: a draft written on a phone has to still be
 * there on a laptop, so nothing here is optimistic — a write lands, then the
 * list is read again. The summary is the exception, because it is typed
 * rather than submitted; it is held locally and saved behind a debounce.
 */
export function useReviewDrafts(
  reviewArtifactId: string | null,
): ReviewDraftStore {
  const rpc = useTasksRpc();
  const drafts = useTasksQuery(
    async (query) =>
      reviewArtifactId === null
        ? null
        : await query.call("listReviewDrafts", { reviewArtifactId }),
    ["tasks:changed"],
    [reviewArtifactId],
  );
  const [error, setError] = useState<string | null>(null);
  // Null means "whatever the server last said"; a string means the reviewer
  // has typed since, and that is what the box must show.
  const [typedSummary, setTypedSummary] = useState<string | null>(null);
  const refresh = drafts.refresh;

  // A review switch drops a note typed against the previous one, which would
  // otherwise be saved onto it by the debounce below.
  useEffect(() => {
    setTypedSummary(null);
    setError(null);
  }, [reviewArtifactId]);

  const savedSummary = drafts.data?.summary ?? "";
  const pendingSummary = typedSummary;
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  useEffect(() => {
    if (reviewArtifactId === null) return;
    if (pendingSummary === null || pendingSummary === savedSummary) return;
    const timer = setTimeout(() => {
      void rpcRef.current
        .call("saveReviewDraftSummary", {
          reviewArtifactId,
          body: pendingSummary,
        })
        .catch((cause: unknown) => setError(message(cause)));
    }, SUMMARY_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [reviewArtifactId, pendingSummary, savedSummary]);

  const flushSummary = useCallback(async () => {
    if (reviewArtifactId === null) return;
    if (pendingSummary === null || pendingSummary === savedSummary) return;
    try {
      await rpc.call("saveReviewDraftSummary", {
        reviewArtifactId,
        body: pendingSummary,
      });
    } catch (cause) {
      setError(message(cause));
    }
  }, [rpc, reviewArtifactId, pendingSummary, savedSummary]);

  const saveComment = useCallback(
    async (input: {
      id?: string | null;
      anchor: ReviewDraftAnchor;
      body: string;
    }) => {
      if (reviewArtifactId === null) return false;
      try {
        await rpc.call("saveReviewDraftComment", {
          id: input.id ?? null,
          reviewArtifactId,
          anchor: input.anchor,
          body: input.body,
        });
        setError(null);
        refresh();
        return true;
      } catch (cause) {
        setError(message(cause));
        return false;
      }
    },
    [rpc, reviewArtifactId, refresh],
  );

  const deleteComment = useCallback(
    async (id: string) => {
      try {
        await rpc.call("deleteReviewDraftComment", { id });
        setError(null);
        refresh();
        return true;
      } catch (cause) {
        setError(message(cause));
        return false;
      }
    },
    [rpc, refresh],
  );

  return {
    comments: drafts.data?.comments ?? [],
    summary: typedSummary ?? savedSummary,
    isLoading: drafts.data === undefined && drafts.error === null,
    error: error ?? drafts.error,
    setSummary: setTypedSummary,
    flushSummary,
    resetSummary: () => setTypedSummary(null),
    saveComment,
    deleteComment,
    refresh,
  };
}
