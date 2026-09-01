import { useCallback, useSyncExternalStore } from "react";

/**
 * Client-local soft-wrap choice for every diff this app renders. Stored in the
 * browser profile, alongside the view preference, because it describes how one
 * screen wants to read code rather than anything about the task record.
 *
 * The setting is deliberately global: a reader who turns wrapping on for a
 * long line wants it on for the next file too, not for that one hunk.
 */
export const DIFF_WRAP_STORAGE_KEY = "bb-tasks:diff-word-wrap";

const DEFAULT_WRAP = false;

function readStoredWrap(): boolean {
  try {
    const raw = window.localStorage.getItem(DIFF_WRAP_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return DEFAULT_WRAP;
  } catch {
    return DEFAULT_WRAP;
  }
}

/**
 * Every mounted diff reads one value, so the toggle has to reach components it
 * does not own. A subscription list is the smallest thing that does that
 * without a provider wrapped around the whole app.
 */
const listeners = new Set<() => void>();

// Storage is the single copy of the value; nothing caches it, so a write from
// anywhere — this tab, another tab, a test — is read back the same way.
const snapshot = readStoredWrap;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab writing the key is the same change as this one making it.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DIFF_WRAP_STORAGE_KEY) return;
    for (const notify of listeners) notify();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setDiffWordWrap(wrap: boolean): void {
  try {
    window.localStorage.setItem(DIFF_WRAP_STORAGE_KEY, String(wrap));
  } catch {
    // Persistence is best-effort (private mode / storage disabled); with no
    // storage the toggle simply does not stick.
  }
  for (const notify of listeners) notify();
}

/** The current wrap setting and a setter, shared by every caller. */
export function useDiffWordWrap(): [boolean, (wrap: boolean) => void] {
  const wrap = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_WRAP);
  const set = useCallback((next: boolean) => setDiffWordWrap(next), []);
  return [wrap, set];
}
