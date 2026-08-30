// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Task } from "../../shared/contract.js";
import { EMPTY_FILTERS, type ListFilterState } from "./filter-bar.js";
import {
  listScrollScopeKey,
  readListScroll,
  resolveRestoreTarget,
  useListScrollRestoration,
  writeListScroll,
} from "./scroll-restoration.js";
import { installBrowserMocks } from "./browser-mocks.js";

installBrowserMocks({ compactViewport: true });

const app = await loadPluginApp(() => import("../../app"));

describe("listScrollScopeKey", () => {
  const base = {
    projectId: null,
    activeOnly: false,
    filters: EMPTY_FILTERS,
    sort: "manual" as const,
  };

  it("distinguishes the all/active/project lists", () => {
    const all = listScrollScopeKey(base);
    const active = listScrollScopeKey({ ...base, activeOnly: true });
    const project = listScrollScopeKey({ ...base, projectId: "proj_1" });
    expect(new Set([all, active, project]).size).toBe(3);
  });

  it("ignores filter member order but reflects filter content", () => {
    const a: ListFilterState = {
      statuses: ["todo", "done"],
      priorities: [],
      labelNames: ["b", "a"],
    };
    const b: ListFilterState = {
      statuses: ["done", "todo"],
      priorities: [],
      labelNames: ["a", "b"],
    };
    expect(listScrollScopeKey({ ...base, filters: a })).toBe(
      listScrollScopeKey({ ...base, filters: b }),
    );
    expect(listScrollScopeKey({ ...base, filters: a })).not.toBe(
      listScrollScopeKey(base),
    );
  });

  it("does not collide distinct label filters that share a delimiter", () => {
    // Label names are arbitrary strings; a naive comma-join would make these
    // two different filters share a key and restore each other's offset.
    const withComma: ListFilterState = {
      statuses: [],
      priorities: [],
      labelNames: ["a,b"],
    };
    const twoLabels: ListFilterState = {
      statuses: [],
      priorities: [],
      labelNames: ["a", "b"],
    };
    expect(listScrollScopeKey({ ...base, filters: withComma })).not.toBe(
      listScrollScopeKey({ ...base, filters: twoLabels }),
    );
  });

  it("distinguishes sort while holding the list fixed", () => {
    expect(listScrollScopeKey(base)).not.toBe(
      listScrollScopeKey({ ...base, sort: "priority" }),
    );
  });
});

describe("resolveRestoreTarget", () => {
  it("clamps a saved offset to the scrollable range", () => {
    // Full-length list: exact offset preserved.
    expect(resolveRestoreTarget(400, 1000, 500)).toBe(400);
    // Shortened list: snap to the new bottom, never past it.
    expect(resolveRestoreTarget(400, 600, 500)).toBe(100);
    // Content now fits entirely: top.
    expect(resolveRestoreTarget(400, 300, 500)).toBe(0);
    // Negative/garbage saved value: top.
    expect(resolveRestoreTarget(-50, 1000, 500)).toBe(0);
  });
});

describe("scroll store", () => {
  // Storage key contract: keep in sync with STORAGE_PREFIX in the module.
  const PREFIX = "bb-tasks:list-scroll:";
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("round-trips a rounded, non-negative offset", () => {
    writeListScroll("all|", 123.7);
    expect(readListScroll("all|")).toBe(124);
    writeListScroll("all|", -5);
    expect(readListScroll("all|")).toBe(0);
  });

  it("persists to sessionStorage under the scoped key", () => {
    writeListScroll("proj:x|", 250);
    expect(window.sessionStorage.getItem(`${PREFIX}proj:x|`)).toBe("250");
  });

  it("reads a value seeded directly in sessionStorage (survives refresh)", () => {
    // A fresh page load starts with an empty in-memory map, so this proves the
    // sessionStorage read path rather than the memory fallback.
    window.sessionStorage.setItem(`${PREFIX}fresh|`, "333");
    expect(readListScroll("fresh|")).toBe(333);
  });

  it("rejects malformed stored values instead of truncating them", () => {
    for (const bad of ["400garbage", "-5", "12.5", "", "NaN", "1e3"]) {
      window.sessionStorage.setItem(`${PREFIX}bad|`, bad);
      expect(readListScroll("bad|")).toBeNull();
    }
  });

  it("falls back to null when a read throws", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(readListScroll("boom|")).toBeNull();
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it("returns null for an unknown scope", () => {
    expect(readListScroll("never-written")).toBeNull();
  });
});

/**
 * A container whose layout metrics can be scripted (jsdom does no layout).
 * scrollHeight is mutable via `el.__sh` so a test can grow the content between
 * rerenders to model late-arriving rows.
 */
function scriptContainer(el: HTMLDivElement, scrollHeight: number): void {
  (el as unknown as { __sh: number }).__sh = scrollHeight;
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => (el as unknown as { __sh: number }).__sh,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 500 });
  let top = 0;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
}

function Harness({
  scopeKey,
  contentReady,
  scrollHeight,
  loading = false,
  revision = 0,
  onReady,
}: {
  scopeKey: string;
  contentReady: boolean;
  scrollHeight: number;
  loading?: boolean;
  revision?: number;
  onReady: (el: HTMLDivElement) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useListScrollRestoration(ref, scopeKey, { contentReady, loading, revision });
  return (
    <div
      ref={(el) => {
        if (el && ref.current !== el) {
          ref.current = el;
          scriptContainer(el, scrollHeight);
          onReady(el);
        } else if (el) {
          // Same element across rerenders: reflect the latest scripted height.
          (el as unknown as { __sh: number }).__sh = scrollHeight;
        }
      }}
      data-testid="scroll"
    />
  );
}

describe("useListScrollRestoration", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("persists on scroll and restores on remount, clamped to content", () => {
    let el: HTMLDivElement | null = null;
    const capture = (node: HTMLDivElement) => {
      el = node;
    };

    // First mount: user scrolls the list down.
    const first = render(
      <Harness
        scopeKey="all|"
        contentReady
        scrollHeight={2000}
        onReady={capture}
      />,
    );
    const firstEl = el as unknown as HTMLDivElement;
    act(() => {
      firstEl.scrollTop = 800;
      firstEl.dispatchEvent(new Event("scroll"));
    });
    // Unmount (navigating into a task) flushes the offset.
    first.unmount();
    expect(readListScroll("all|")).toBe(800);

    // Remount (back to the list) with a now-shorter list: offset is clamped
    // to the new scrollable range instead of hanging past the end.
    el = null;
    render(
      <Harness
        scopeKey="all|"
        contentReady
        scrollHeight={1000}
        onReady={capture}
      />,
    );
    const secondEl = el as unknown as HTMLDivElement;
    // scrollHeight 1000 - clientHeight 500 => max 500.
    expect(secondEl.scrollTop).toBe(500);
  });

  it("re-applies the target as late-arriving rows grow the scroll height", () => {
    // Regression: switching scope (e.g. clearing a filter) keeps the previous,
    // shorter rows mounted for a frame while the fetch is in flight. Applying
    // the target once would clamp it against that stale height and stick.
    writeListScroll("grow|", 680);
    let el: HTMLDivElement | null = null;
    const capture = (node: HTMLDivElement) => {
      el = node;
    };
    // First paint: stale/short content (height 1021 => max 521), still loading.
    const view = render(
      <Harness
        scopeKey="grow|"
        contentReady
        loading
        revision={29}
        scrollHeight={1021}
        onReady={capture}
      />,
    );
    const node = el as unknown as HTMLDivElement;
    expect(node.scrollTop).toBe(521); // clamped to the short height for now

    // The real rows arrive: taller content, fetch settled.
    view.rerender(
      <Harness
        scopeKey="grow|"
        contentReady
        loading={false}
        revision={40}
        scrollHeight={1498}
        onReady={capture}
      />,
    );
    // Now the full offset is honored (1498 - 500 = 998 >= 680).
    expect(node.scrollTop).toBe(680);
  });

  it("abandons an unreached pending target once the user scrolls", () => {
    // Regression: a target that never fit the (short) content stays pending; a
    // later rerender must not yank the user back to it after they scroll away.
    writeListScroll("cancel|", 900);
    let el: HTMLDivElement | null = null;
    const capture = (node: HTMLDivElement) => {
      el = node;
    };
    const view = render(
      <Harness
        scopeKey="cancel|"
        contentReady
        loading
        revision={1}
        scrollHeight={1000}
        onReady={capture}
      />,
    );
    const node = el as unknown as HTMLDivElement;
    expect(node.scrollTop).toBe(500); // clamped; 900 still pending, loading

    // User scrolls elsewhere.
    act(() => {
      node.scrollTop = 120;
      node.dispatchEvent(new Event("scroll"));
    });

    // A later refetch rerenders with a taller list that *could* honor 900.
    view.rerender(
      <Harness
        scopeKey="cancel|"
        contentReady
        loading={false}
        revision={2}
        scrollHeight={2000}
        onReady={capture}
      />,
    );
    // The pending restore was abandoned on the user scroll — they stay put.
    expect(node.scrollTop).toBe(120);
  });

  it("flushes the observed offset, not a detached container's zeroed scrollTop", () => {
    // Regression: on unmount React has already detached the list container, so
    // reading el.scrollTop there yields 0 and would clobber the saved offset.
    let el: HTMLDivElement | null = null;
    const view = render(
      <Harness
        scopeKey="detach|"
        contentReady
        scrollHeight={2000}
        onReady={(node) => {
          el = node;
        }}
      />,
    );
    const node = el as unknown as HTMLDivElement;
    act(() => {
      node.scrollTop = 620;
      node.dispatchEvent(new Event("scroll"));
    });
    // Simulate the browser zeroing scrollTop as the node is detached — with no
    // scroll event, exactly what happens during an unmount transition.
    node.scrollTop = 0;
    view.unmount();
    expect(readListScroll("detach|")).toBe(620);
  });

  it("does not restore a different list's offset (pins new scope to top)", () => {
    writeListScroll("all|", 600);
    let el: HTMLDivElement | null = null;
    render(
      <Harness
        scopeKey="project:proj_1|"
        contentReady
        scrollHeight={2000}
        onReady={(node) => {
          el = node;
        }}
      />,
    );
    const target = el as unknown as HTMLDivElement;
    expect(target.scrollTop).toBe(0);
  });

  it("stays pinned to top and saves nothing while content is loading", () => {
    let el: HTMLDivElement | null = null;
    render(
      <Harness
        scopeKey="loading|"
        contentReady={false}
        scrollHeight={0}
        onReady={(node) => {
          el = node;
        }}
      />,
    );
    const target = el as unknown as HTMLDivElement;
    act(() => {
      target.scrollTop = 300;
      target.dispatchEvent(new Event("scroll"));
    });
    expect(readListScroll("loading|")).toBeNull();
  });
});

/**
 * The list view's own settle signal. Filters and sort are applied to rows the
 * view already holds — no refetch — so a filter change must leave nothing
 * pending for a later render to act on.
 */
describe("filter changes in the mounted list", () => {
  const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP9";

  function task(number: number, status: Task["status"]): Task {
    return {
      id: `01HZZZZZZZZZZZZZZZZZZZZZS${number}`,
      projectId: PROJECT_ID,
      number,
      key: `TSK-${number}`,
      title: `Task ${number}`,
      description: "",
      status,
      priority: "none",
      dueDate: null,
      parentTaskId: null,
      position: number,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      labelIds: [],
    };
  }

  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  afterEach(cleanup);

  it("settles the scroll scope in the render that changed it", async () => {
    const rows = [task(1, "todo"), task(2, "todo"), task(3, "done")];
    let listCalls = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: PROJECT_ID },
      {
        rpc: {
          listProjects: () => ({
            projects: [
              {
                id: PROJECT_ID,
                name: "Tasks Plugin",
                prefix: "TSK",
                nextTaskNumber: 9,
                color: "blue",
                folderId: null,
                linkedBbProjectId: null,
                createdAt: "2026-07-15T00:00:00.000Z",
              },
            ],
          }),
          listFolders: () => ({ folders: [] }),
          listPresets: () => ({ presets: [] }),
          sidebarSummary: () => ({ projects: [] }),
          listLabels: () => ({ labels: [] }),
          // The refetch brings one more row, so the restorer sees a new
          // revision — the moment a stale pending target would be applied.
          listTasks: () => ({
            tasks: listCalls++ === 0 ? rows : [...rows, task(4, "todo")],
          }),
          listTaskThreads: () => ({ taskThreads: [] }),
          listComments: () => ({ comments: [] }),
          listAttachments: () => ({ attachments: [] }),
        },
      },
    );
    await slot.findByText("TSK-1");

    // The scrolling container; jsdom does no layout, so script its metrics.
    const container =
      slot.container.querySelector<HTMLDivElement>(".overflow-y-auto");
    if (container === null) throw new Error("scroll container not found");
    scriptContainer(container, 600);

    // A remembered offset for the filtered scope that the current height
    // cannot honor: 600 - 500 leaves room for 100 of the saved 400.
    writeListScroll(
      listScrollScopeKey({
        projectId: PROJECT_ID,
        activeOnly: false,
        filters: { statuses: ["todo"], priorities: [], labelNames: [] },
        sort: "manual",
      }),
      400,
    );

    fireEvent.click(slot.getByRole("button", { name: /Status/ }));
    fireEvent.click(await slot.findByRole("menuitemcheckbox", { name: /Todo/ }));
    await waitFor(() => expect(container.scrollTop).toBe(100));

    // Rows arrive from an unrelated invalidation and the list grows. A scope
    // that only settled in an effect would still be chasing 400 and jump.
    (container as unknown as { __sh: number }).__sh = 1000;
    await slot.emitRealtime("tasks:changed", {});
    await slot.findByText("TSK-4");
    expect(container.scrollTop).toBe(100);
  });
});
