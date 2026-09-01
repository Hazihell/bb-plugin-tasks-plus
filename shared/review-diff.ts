export interface ReviewConcernMetadata {
  concerns: readonly ReviewConcern[];
}

interface ReviewConcern {
  hunks: readonly ReviewHunk[];
}

interface ReviewHunk {
  path: string;
}

/** Keep the backend request aligned with the files the review actually cites. */
export function reviewConcernPaths(
  metadata: ReviewConcernMetadata,
): string[] {
  const paths = new Set<string>();
  for (const concern of metadata.concerns) {
    for (const hunk of concern.hunks) paths.add(hunk.path);
  }
  return [...paths];
}

/** An unavailable head cannot prove that the pinned review has drifted. */
export function isReviewStale(
  pinnedHeadSha: string,
  currentHeadSha: string | null,
): boolean {
  return currentHeadSha !== null && currentHeadSha !== pinnedHeadSha;
}
