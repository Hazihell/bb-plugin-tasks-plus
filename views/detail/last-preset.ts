import { useSyncExternalStore } from "react";
import type { Preset } from "../../shared/contract.js";

const STORAGE_KEY = "bb-tasks:last-dispatch-preset";

/**
 * The dispatch preset this browser last used. Kept as a tiny shared store
 * rather than component state: the dispatch control writes it and the rail's
 * base-branch read-out reads it, and the read-out would otherwise go stale
 * the moment someone dispatched with a different preset.
 */
function read(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

// Storage is the store: getItem returns the same string primitive on repeated
// reads, so useSyncExternalStore sees a stable snapshot without a cache — and
// a value written outside this module is never masked by a stale one.
export function useLastPresetId(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    read,
  );
}

export function rememberPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, presetId);
  } catch {
    // Persistence is best-effort (e.g. sandboxed iframes without storage).
  }
  for (const listener of listeners) listener();
}

/**
 * The preset a dispatch would use with no further choice: the remembered one,
 * else the preset that ships with the plugin — the one every install has —
 * before falling back to alphabetical order.
 */
export function defaultDispatchPreset(
  presets: readonly Preset[] | undefined,
  lastPresetId: string | null,
): Preset | undefined {
  if (presets === undefined) return undefined;
  return (
    presets.find((preset) => preset.id === lastPresetId) ??
    presets.find((preset) => preset.builtin) ??
    [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
  );
}
