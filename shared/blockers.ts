import type { TaskStatus } from "./contract.js";

/**
 * The statuses that settle a blocker. Every layer reads the rule from here:
 * the TypeScript predicate below, and — because SQL cannot import it — the
 * status list the store interpolates into its blocker counts.
 */
export const RESOLVED_BLOCKER_STATUSES = [
  "done",
  "canceled",
] as const satisfies readonly TaskStatus[];

/** A blocker stops counting once it is done or canceled. */
export function isBlockerResolved(status: TaskStatus): boolean {
  return (RESOLVED_BLOCKER_STATUSES as readonly TaskStatus[]).includes(status);
}
