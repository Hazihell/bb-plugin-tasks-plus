// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LIST_PREFERENCE,
  LIST_PREFERENCE_STORAGE_KEY,
  LIST_PREFERENCE_VERSION,
  listPreferenceScope,
  loadListPreference,
  sanitizeListPreference,
  storeListPreference,
} from "./list-preference.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listPreferenceScope", () => {
  it("maps list surfaces to independent scopes", () => {
    expect(listPreferenceScope(null, false)).toBe("all");
    expect(listPreferenceScope(null, true)).toBe("active");
    expect(listPreferenceScope("01HZZZZZZZZZZZZZZZZZZZZZP1", false)).toBe(
      "project:01HZZZZZZZZZZZZZZZZZZZZZP1",
    );
    // activeOnly wins over a project id (Active route is cross-project).
    expect(listPreferenceScope("01HZZZZZZZZZZZZZZZZZZZZZP1", true)).toBe(
      "active",
    );
  });
});

describe("sanitizeListPreference", () => {
  it("returns defaults for missing or garbage input", () => {
    expect(sanitizeListPreference(undefined)).toEqual({
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
    expect(sanitizeListPreference(null)).toEqual({
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
    expect(sanitizeListPreference("nope")).toEqual({
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });

  it("drops invalid statuses, priorities, and sort; keeps label names", () => {
    expect(
      sanitizeListPreference({
        filters: {
          statuses: ["todo", "not-a-status", "todo", "done"],
          priorities: ["high", 3, "high", "telepathic"],
          labelNames: [" Bug ", "", "Bug", "Feature", 12],
        },
        sort: "priority-please",
        collapsedStatuses: [],
        expandedParents: [],
      }),
    ).toEqual({
      filters: {
        statuses: ["todo", "done"],
        priorities: ["high"],
        labelNames: ["Bug", "Feature"],
      },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });

  it("keeps known collapsed statuses and drops the rest", () => {
    expect(
      sanitizeListPreference({
        filters: { statuses: [], priorities: [], labelNames: [] },
        sort: "manual",
        collapsedStatuses: ["backlog", "nope", 7, "backlog", "done"],
      }).collapsedStatuses,
    ).toEqual(["backlog", "done"]);
    // A document written before the field shipped reads as nothing collapsed.
    expect(
      sanitizeListPreference({
        filters: { statuses: [], priorities: [], labelNames: [] },
        sort: "manual",
      }).collapsedStatuses,
    ).toEqual([]);
  });

  it("accepts a valid preference and known sort modes", () => {
    expect(
      sanitizeListPreference({
        filters: {
          statuses: ["in_progress"],
          priorities: ["urgent", "none"],
          labelNames: ["infra"],
        },
        sort: "due",
        collapsedStatuses: [],
        expandedParents: [],
      }),
    ).toEqual({
      filters: {
        statuses: ["in_progress"],
        priorities: ["urgent", "none"],
        labelNames: ["infra"],
      },
      sort: "due",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });
});

describe("loadListPreference / storeListPreference", () => {
  it("defaults when storage is empty", () => {
    expect(loadListPreference("all")).toEqual({
      filters: { ...DEFAULT_LIST_PREFERENCE.filters },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });

  it("round-trips a preference for one scope without touching another", () => {
    storeListPreference("all", {
      filters: {
        statuses: ["todo"],
        priorities: ["high"],
        labelNames: ["Bug"],
      },
      sort: "priority",
      collapsedStatuses: [],
      expandedParents: [],
    });
    storeListPreference("project:p1", {
      filters: {
        statuses: ["done"],
        priorities: [],
        labelNames: [],
      },
      sort: "due",
      collapsedStatuses: [],
      expandedParents: [],
    });

    expect(loadListPreference("all")).toEqual({
      filters: {
        statuses: ["todo"],
        priorities: ["high"],
        labelNames: ["Bug"],
      },
      sort: "priority",
      collapsedStatuses: [],
      expandedParents: [],
    });
    expect(loadListPreference("project:p1")).toEqual({
      filters: {
        statuses: ["done"],
        priorities: [],
        labelNames: [],
      },
      sort: "due",
      collapsedStatuses: [],
      expandedParents: [],
    });
    expect(loadListPreference("active")).toEqual({
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });

    const stored = JSON.parse(
      window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY)!,
    );
    expect(stored.version).toBe(LIST_PREFERENCE_VERSION);
    expect(Object.keys(stored.scopes).sort()).toEqual(["all", "project:p1"]);
  });

  it("round-trips the collapsed status set per scope", () => {
    storeListPreference("all", {
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: ["backlog", "done"],
    });
    storeListPreference("project:p1", {
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: ["canceled"],
    });
    expect(loadListPreference("all").collapsedStatuses).toEqual([
      "backlog",
      "done",
    ]);
    expect(loadListPreference("project:p1").collapsedStatuses).toEqual([
      "canceled",
    ]);
    expect(loadListPreference("active").collapsedStatuses).toEqual([]);

    // Expanding every group again is a state worth persisting, not a reset.
    storeListPreference("all", {
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
    expect(loadListPreference("all").collapsedStatuses).toEqual([]);
  });

  it("reads a stored document written without the collapsed field", () => {
    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: LIST_PREFERENCE_VERSION,
        scopes: {
          all: {
            filters: { statuses: ["todo"], priorities: [], labelNames: [] },
            sort: "due",
          },
        },
      }),
    );
    expect(loadListPreference("all")).toEqual({
      filters: { statuses: ["todo"], priorities: [], labelNames: [] },
      sort: "due",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });

  it("persists an explicit clear (empty filters + manual sort)", () => {
    storeListPreference("all", {
      filters: { statuses: ["todo"], priorities: [], labelNames: [] },
      sort: "priority",
      collapsedStatuses: [],
      expandedParents: [],
    });
    storeListPreference("all", {
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
    expect(loadListPreference("all")).toEqual({
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });

  it("recovers from corrupt JSON and invalid document shapes", () => {
    window.localStorage.setItem(LIST_PREFERENCE_STORAGE_KEY, "{not-json");
    expect(loadListPreference("all").sort).toBe("manual");

    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({ version: 1, scopes: "nope" }),
    );
    expect(loadListPreference("all").filters.statuses).toEqual([]);

    window.localStorage.setItem(
      LIST_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        scopes: {
          all: {
            filters: { statuses: ["bogus"], priorities: ["high"] },
            sort: "priority",
          },
        },
      }),
    );
    expect(loadListPreference("all")).toEqual({
      filters: { statuses: [], priorities: ["high"], labelNames: [] },
      sort: "priority",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });

  it("best-effort reads scopes from an unknown future version without rewriting it", () => {
    const future = JSON.stringify({
      version: 99,
      scopes: {
        all: {
          filters: { statuses: ["todo"], priorities: [], labelNames: [] },
          sort: "due",
          extraFutureField: true,
        },
      },
    });
    window.localStorage.setItem(LIST_PREFERENCE_STORAGE_KEY, future);
    expect(loadListPreference("all")).toEqual({
      filters: { statuses: ["todo"], priorities: [], labelNames: [] },
      sort: "due",
      collapsedStatuses: [],
      expandedParents: [],
    });
    storeListPreference("all", {
      filters: { statuses: ["done"], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
    // Older client must not down-convert a newer document.
    expect(window.localStorage.getItem(LIST_PREFERENCE_STORAGE_KEY)).toBe(
      future,
    );
  });

  it("swallows storage write failures", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    expect(() =>
      storeListPreference("all", {
        filters: { statuses: ["todo"], priorities: [], labelNames: [] },
        sort: "manual",
        collapsedStatuses: [],
        expandedParents: [],
      }),
    ).not.toThrow();
  });

  it("swallows storage read failures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage is disabled", "SecurityError");
    });
    expect(loadListPreference("all")).toEqual({
      filters: { statuses: [], priorities: [], labelNames: [] },
      sort: "manual",
      collapsedStatuses: [],
      expandedParents: [],
    });
  });
});
