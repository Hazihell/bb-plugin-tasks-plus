// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// loadPluginApp installs the fake SDK runtime; nothing SDK-touching may be
// imported before it runs.
const app = await loadPluginApp(() => import("../../app"));
// Imported after the runtime is installed, for the same reason app.tsx is.
const { useHostCodeTheme } = await import("./diff.js");

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const REVIEW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const OTHER_REVIEW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";
const EVIDENCE_ID = "01HZZZZZZZZZZZZZZZZZZZZZE1";
const MISSING_ID = "01HZZZZZZZZZZZZZZZZZZZZZE9";

const PINNED_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOVED_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// No `--- / +++` headers, so the diff renderer parses no file out of it and
// the view must fall back to showing the patch as text.
const UNPARSEABLE_PATCH = [
  "@@ -1,3 +1,4 @@",
  " const one = 1;",
  "+const two = 2;",
  " const three = 3;",
  "",
].join("\n");

// Two hunks, of which a concern citing lines 1-4 keeps only the first, so the
// card must say what it left out.
const TWO_HUNK_PATCH = [
  "@@ -1,3 +1,4 @@",
  " const one = 1;",
  "+const two = 2;",
  " const three = 3;",
  "@@ -20,3 +21,4 @@",
  " const twenty = 20;",
  "+const far = 21;",
  " const away = 22;",
  "",
].join("\n");

const task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Read the review",
  description: "",
  status: "todo",
  priority: "none",
  dueDate: null,
  parentTaskId: null,
  position: 1,
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
  labelIds: [],
};

const evidence = {
  id: EVIDENCE_ID,
  taskId: TASK_ID,
  kind: "evidence",
  title: "Typecheck passes",
  body: null,
  externalUrl: null,
  attachmentId: null,
  sourceThreadId: null,
  metadata: { command: "npm run typecheck", exitCode: 0, evidenceKind: "test" },
  createdAt: "2026-07-15T09:00:00.000Z",
};

function reviewArtifact(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    taskId: TASK_ID,
    kind: "review",
    title: "Narrative review of the slicing seam",
    body: null,
    externalUrl: null,
    attachmentId: null,
    sourceThreadId: null,
    metadata: {
      baseRef: "main",
      headSha: PINNED_SHA,
      environmentId: "env_abc",
      concerns: [
        {
          title: "Slicing hides the rest of the file",
          why: "A concern names lines, so unrelated hunks must not appear.",
          // One resolvable citation and one stale id: the stale one is simply
          // not rendered.
          evidence: [EVIDENCE_ID, MISSING_ID],
          decisions: [],
          risks: "A wrong slice silently under-reports the change.",
          hunks: [{ path: "shared/patch-slice.ts", startLine: 1, endLine: 4 }],
        },
        {
          title: "Staleness is the frontend's call",
          why: "The backend reports heads; the UI decides what that means.",
          evidence: [],
          decisions: [],
          risks: "",
          hunks: [],
        },
      ],
    },
    createdAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

function reviewRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
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
    listTasks: () => ({ tasks: [task] }),
    getTaskByKey: () => ({ task }),
    listArtifacts: () => ({ artifacts: [evidence, reviewArtifact()] }),
    getReviewDiff: () => ({
      outcome: "available",
      baseRef: "main",
      pinnedHeadSha: PINNED_SHA,
      currentHeadSha: PINNED_SHA,
      environmentId: "env_abc",
      files: [
        {
          path: "shared/patch-slice.ts",
          patch: UNPARSEABLE_PATCH,
          truncated: false,
        },
      ],
    }),
    ...overrides,
  };
}

const openReview = (rpc: Record<string, unknown>, subPath = "review/TSK-5") =>
  renderSlot(app.navPanels[0]!, { subPath }, { rpc });

describe("review route", () => {
  it("renders every concern with its prose, risks and resolvable citations", async () => {
    const slot = openReview(reviewRpc());

    await slot.findByText("Narrative review of the slicing seam");
    slot.getByText("Slicing hides the rest of the file");
    slot.getByText("Staleness is the frontend's call");
    slot.getByText(
      "A concern names lines, so unrelated hunks must not appear.",
    );
    slot.getByText("A wrong slice silently under-reports the change.");
    // The resolvable citation renders; the stale id contributes nothing.
    slot.getByText("Typecheck passes");
    expect(slot.container.textContent).not.toContain(MISSING_ID);
    // The header pins the reviewed range.
    expect(slot.container.textContent).toContain("main..aaaaaaa");
  });

  it("keeps the toolbar and each file header free to stick", async () => {
    const slot = openReview(reviewRpc());

    const fallback = await slot.findByText(/\+const two = 2;/);
    const fileHeader = slot
      .getByText("shared/patch-slice.ts")
      .closest<HTMLElement>(".sticky")!;
    expect(fileHeader).not.toBeNull();
    // A sticky element sticks to its nearest scrolling ancestor. The route's
    // own scroll area must be the first one found: anything that clips in
    // between would pin the header to a box that never scrolls.
    let scroller: HTMLElement | null = null;
    for (
      let element: HTMLElement | null = fileHeader.parentElement;
      element !== null && scroller === null;
      element = element.parentElement
    ) {
      expect(element.className).not.toMatch(/\boverflow-hidden\b/);
      if (/\boverflow-(auto|scroll)\b/.test(element.className)) {
        scroller = element;
      }
    }
    expect(scroller).not.toBeNull();
    // The patch itself may clip; it is below the header, not above it.
    expect(fallback.closest(".overflow-hidden")).not.toBeNull();
  });

  it("keeps the review inside the width of a phone", async () => {
    const originalWidth = window.innerWidth;
    window.innerWidth = 390;
    const slot = openReview(reviewRpc());

    const toolbar = (await slot.findByRole("button", { name: /Wrap lines/ }))
      .parentElement!;
    expect(toolbar.className).toContain("sticky");
    // At this width the document has no centring slack, so anything reaching
    // outside its parent's content box between here and the scroller is
    // wider than the scroller: the whole page would pan sideways and this
    // bar's left edge would be cut off.
    for (
      let element: HTMLElement | null = toolbar;
      element !== null && !/\boverflow-(auto|scroll)\b/.test(element.className);
      element = element.parentElement
    ) {
      expect(element.className).not.toMatch(/(^|\s)-m[a-z]?-/);
    }
    window.innerWidth = originalWidth;
  });

  it("wraps every diff at once and remembers the choice", async () => {
    const slot = openReview(reviewRpc());

    const fallback = await slot.findByText(/\+const two = 2;/);
    // Sideways panning is possible, so the host's sidebar swipe is refused.
    expect(fallback.closest("[data-no-sidebar-swipe]")).not.toBeNull();
    expect(fallback.className).toContain("overflow-x-auto");

    fireEvent.click(slot.getByRole("button", { name: /Wrap lines/ }));

    expect(fallback.className).toContain("whitespace-pre-wrap");
    // Nothing to pan any more, so the swipe belongs to the sidebar again.
    expect(fallback.closest("[data-no-sidebar-swipe]")).toBeNull();
    expect(window.localStorage.getItem("bb-tasks:diff-word-wrap")).toBe("true");
  });

  it("starts wrapped when the stored preference says so", async () => {
    window.localStorage.setItem("bb-tasks:diff-word-wrap", "true");
    const slot = openReview(reviewRpc());

    const fallback = await slot.findByText(/\+const two = 2;/);
    expect(fallback.className).toContain("whitespace-pre-wrap");
  });

  it("shows the patch as text when the diff renderer parses no file", async () => {
    const slot = openReview(reviewRpc());

    const fallback = await slot.findByText(/\+const two = 2;/);
    expect(fallback.tagName).toBe("PRE");
  });

  it("warns when the branch has moved past the reviewed head", async () => {
    const slot = openReview(
      reviewRpc({
        getReviewDiff: () => ({
          outcome: "available",
          baseRef: "main",
          pinnedHeadSha: PINNED_SHA,
          currentHeadSha: MOVED_SHA,
          environmentId: "env_abc",
          files: [],
        }),
      }),
    );

    await slot.findByText(/The branch has moved since this review was written/);
  });

  it("stays quiet when the head still matches the reviewed one", async () => {
    const slot = openReview(reviewRpc());

    // Wait for the diff itself: the banner, if it were coming, would arrive
    // with it.
    await slot.findByText(/\+const two = 2;/);
    expect(slot.container.textContent).not.toContain(
      "The branch has moved since this review was written",
    );
  });

  it("keeps the narrative when the diff is unavailable and says why", async () => {
    const slot = openReview(
      reviewRpc({
        getReviewDiff: () => ({
          outcome: "unavailable",
          reason: "no_environment",
          message: "TSK-5 has no attached environment.",
        }),
      }),
    );

    await slot.findByText("Slicing hides the rest of the file");
    await slot.findByText(/no environment is attached to this task/);
    expect(slot.container.querySelector("pre")).toBeNull();
  });

  it("says so when the task carries no review artifact", async () => {
    const slot = openReview(
      reviewRpc({ listArtifacts: () => ({ artifacts: [evidence] }) }),
    );

    await slot.findByText("TSK-5 has no review artifact yet.");
  });

  it("says so when the current head could not be read", async () => {
    const slot = openReview(
      reviewRpc({
        getReviewDiff: () => ({
          outcome: "available",
          baseRef: "main",
          pinnedHeadSha: PINNED_SHA,
          currentHeadSha: null,
          environmentId: "env_abc",
          files: [],
        }),
      }),
    );

    await slot.findByText(/Could not confirm/);
    expect(slot.container.textContent).not.toContain(
      "The branch has moved since this review was written",
    );
  });

  it("keeps the written narrative out of the way until it is asked for", async () => {
    const slot = openReview(
      reviewRpc({
        listArtifacts: () => ({
          artifacts: [
            evidence,
            reviewArtifact({ body: "The narrative the reviewer wrote." }),
          ],
        }),
      }),
    );

    const disclosure = await slot.findByText("Written review");
    expect(slot.queryByText("The narrative the reviewer wrote.")).toBeNull();
    fireEvent.click(disclosure);
    await slot.findByText("The narrative the reviewer wrote.");
  });

  it("never pairs a review with another artifact's patches", async () => {
    const otherReview = reviewArtifact({
      id: OTHER_REVIEW_ID,
      title: "A second review of the same file",
      createdAt: "2026-07-16T10:00:00.000Z",
      metadata: {
        baseRef: "main",
        headSha: PINNED_SHA,
        environmentId: "env_abc",
        concerns: [
          {
            title: "The second review's only concern",
            why: "It cites the same file the first review cited.",
            evidence: [],
            decisions: [],
            risks: "",
            hunks: [
              { path: "shared/patch-slice.ts", startLine: 1, endLine: 4 },
            ],
          },
        ],
      },
    });
    const slot = openReview(
      reviewRpc({
        listArtifacts: () => ({
          artifacts: [evidence, reviewArtifact(), otherReview],
        }),
        // The second review's diff never settles, so anything on screen
        // under it can only be the first review's retained patches.
        getReviewDiff: ({ artifactId }: { artifactId: string }) =>
          artifactId === REVIEW_ID
            ? {
                outcome: "available",
                baseRef: "main",
                pinnedHeadSha: PINNED_SHA,
                currentHeadSha: PINNED_SHA,
                environmentId: "env_abc",
                files: [
                  {
                    path: "shared/patch-slice.ts",
                    patch: UNPARSEABLE_PATCH,
                    truncated: false,
                  },
                ],
              }
            : new Promise<never>(() => {}),
      }),
      `review/TSK-5/${REVIEW_ID}`,
    );

    await slot.findByText(/\+const two = 2;/);

    const Panel = app.navPanels[0]!.component;
    slot.lifecycle.rerender(
      <Panel subPath={`review/TSK-5/${OTHER_REVIEW_ID}`} />,
    );

    await slot.findByText("The second review's only concern");
    expect(slot.container.textContent).not.toContain("+const two = 2;");
  });
});

// jsdom has no ResizeObserver, which the diff renderer sets up on mount; a
// stub is enough for it to lay a patch out and hand back its shadow tree.
// The round switcher is a Radix menu: jsdom implements neither pointer
// capture nor matchMedia, and Radix asks for both before it will open.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??=
  TestResizeObserver as unknown as typeof ResizeObserver;

const THREAD_ID = "thr_review";
const OTHER_THREAD_ID = "thr_other";
const DRAFT_ID = "01HZZZZZZZZZZZZZZZZZZZZZC1";
const FEEDBACK_ID = "01HZZZZZZZZZZZZZZZZZZZZZF1";

// A patch the renderer can actually parse, so the line the comment hangs on
// is a line the diff drew.
const PARSED_PATCH = [
  "diff --git a/shared/patch-slice.ts b/shared/patch-slice.ts",
  "index 1111111..2222222 100644",
  "--- a/shared/patch-slice.ts",
  "+++ b/shared/patch-slice.ts",
  "@@ -1,3 +1,4 @@",
  " const one = 1;",
  "+const two = 2;",
  " const three = 3;",
  "",
].join("\n");

const lineDraft = {
  id: DRAFT_ID,
  reviewArtifactId: REVIEW_ID,
  anchor: {
    anchor: "lines",
    path: "shared/patch-slice.ts",
    side: "additions",
    startLine: 2,
    endLine: 2,
    quotedLines: ["+const two = 2;"],
  },
  body: "This line worries me",
  createdAt: "2026-07-15T11:00:00.000Z",
  updatedAt: "2026-07-15T11:00:00.000Z",
};

const FILE_DRAFT_ID = "01HZZZZZZZZZZZZZZZZZZZZZC2";

const fileDraft = {
  id: FILE_DRAFT_ID,
  reviewArtifactId: REVIEW_ID,
  anchor: { anchor: "file", path: "shared/patch-slice.ts" },
  body: "This file does two jobs",
  createdAt: "2026-07-15T11:00:00.000Z",
  updatedAt: "2026-07-15T11:00:00.000Z",
};

/** Two concerns that both cite the one file the diff returns. */
const twiceCitedReview = reviewArtifact({
  sourceThreadId: THREAD_ID,
  metadata: {
    baseRef: "main",
    headSha: PINNED_SHA,
    environmentId: "env_abc",
    concerns: [
      {
        title: "The first concern about this file",
        why: "It cites lines 1 to 4.",
        evidence: [],
        decisions: [],
        risks: "",
        hunks: [{ path: "shared/patch-slice.ts", startLine: 1, endLine: 4 }],
      },
      {
        title: "The second concern about the same file",
        why: "It cites the same lines again.",
        evidence: [],
        decisions: [],
        risks: "",
        hunks: [{ path: "shared/patch-slice.ts", startLine: 1, endLine: 4 }],
      },
    ],
  },
});

function taskThread(threadId: string, title: string) {
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZT${threadId.length}`,
    taskId: TASK_ID,
    threadId,
    presetName: "reviewer",
    title,
    liveStatus: "idle",
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function answerableRpc(overrides: Record<string, unknown> = {}) {
  return reviewRpc({
    listArtifacts: () => ({
      artifacts: [reviewArtifact({ sourceThreadId: THREAD_ID })],
    }),
    getReviewDiff: () => ({
      outcome: "available",
      baseRef: "main",
      pinnedHeadSha: PINNED_SHA,
      currentHeadSha: PINNED_SHA,
      environmentId: "env_abc",
      files: [
        {
          path: "shared/patch-slice.ts",
          patch: PARSED_PATCH,
          truncated: false,
        },
      ],
    }),
    listReviewDrafts: () => ({ comments: [], summary: "" }),
    listTaskThreads: () => ({
      taskThreads: [
        taskThread(OTHER_THREAD_ID, "A second thread"),
        taskThread(THREAD_ID, "The reviewing thread"),
      ],
    }),
    saveReviewDraftComment: () => ({ comment: lineDraft }),
    deleteReviewDraftComment: () => ({ deleted: true }),
    saveReviewDraftSummary: () => ({ ok: true }),
    submitReviewFeedback: () => ({
      outcome: "submitted",
      artifactId: FEEDBACK_ID,
      threadId: THREAD_ID,
    }),
    ...overrides,
  });
}

/** The shadow tree the diff renderer built for the one rendered file. */
function diffShadowRoot(container: HTMLElement): ShadowRoot {
  const host = container.querySelector("diffs-container");
  if (host === null) throw new Error("no diff was rendered");
  const root = host.shadowRoot;
  if (root === null) throw new Error("the diff rendered no shadow tree");
  return root;
}

describe("review comments", () => {
  it("hangs an unsent comment on the line it points at", async () => {
    const slot = openReview(
      answerableRpc({
        listReviewDrafts: () => ({ comments: [lineDraft], summary: "" }),
      }),
    );

    await slot.findAllByText("This line worries me");
    // The renderer opened a slot for exactly that line and side, and the
    // comment is what it projects into it: the comment sits under line 2 of
    // the patch, not merely somewhere on the page.
    await waitFor(() => {
      const annotation = diffShadowRoot(
        slot.container,
      ).querySelector<HTMLSlotElement>("slot[name='annotation-additions-2']");
      expect(annotation).not.toBeNull();
      expect(annotation!.assignedNodes()[0]!.textContent).toContain(
        "This line worries me",
      );
    });
  });

  it("leaves the patch's own lines selectable", async () => {
    const slot = openReview(answerableRpc());

    await slot.findByText("Slicing hides the rest of the file");
    await waitFor(() => {
      const code = diffShadowRoot(slot.container).querySelector("pre");
      expect(code?.hasAttribute("data-interactive-line-numbers")).toBe(true);
    });
  });

  it("takes a remark about a whole file from that file's header", async () => {
    const slot = openReview(answerableRpc());

    const open = await slot.findByRole("button", {
      name: "Comment on shared/patch-slice.ts",
    });
    fireEvent.click(open);
    fireEvent.change(await slot.findByLabelText("Comment"), {
      target: { value: "This file does two jobs" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "saveReviewDraftComment",
        input: {
          id: null,
          reviewArtifactId: REVIEW_ID,
          anchor: { anchor: "file", path: "shared/patch-slice.ts" },
          body: "This file does two jobs",
        },
      }),
    );
  });

  it("keeps the file's comment button beside its name, note or no note", async () => {
    const slot = openReview(
      answerableRpc({
        getReviewDiff: () => ({
          outcome: "available",
          baseRef: "main",
          pinnedHeadSha: PINNED_SHA,
          currentHeadSha: PINNED_SHA,
          environmentId: "env_abc",
          files: [
            {
              path: "shared/patch-slice.ts",
              patch: TWO_HUNK_PATCH,
              truncated: false,
            },
          ],
        }),
      }),
    );

    // The card had to drop a hunk, so it says so.
    await slot.findByText(/1 other hunk in this file/);
    const open = slot.getByRole("button", {
      name: "Comment on shared/patch-slice.ts",
    });
    // A note long enough to wrap shares no row with the button, so it can
    // never push it out of the header.
    const row = open.parentElement!;
    expect(row.textContent).toContain("shared/patch-slice.ts");
    expect(row.textContent).not.toContain("other hunk");
    // And the path is shown whole: it wraps, it never gets cut short.
    const name = slot.getByText("shared/patch-slice.ts");
    expect(name.className).not.toContain("truncate");
  });

  it("draws a remark about a file once, however many concerns cite it", async () => {
    const slot = openReview(
      answerableRpc({
        listArtifacts: () => ({ artifacts: [twiceCitedReview] }),
        listReviewDrafts: () => ({ comments: [fileDraft], summary: "" }),
      }),
    );

    // Both concerns are on screen, so both cards for the file are too.
    await slot.findByText("The second concern about the same file");
    // The remark is about the file, not about either concern's lines: one
    // card carries it, with one pair of controls over it.
    // The submit panel lists it too, so count only the cards: the body, and
    // the one pair of controls over it.
    await waitFor(() =>
      expect(
        slot.getAllByText("This file does two jobs", { selector: "p" }),
      ).toHaveLength(1),
    );
    expect(slot.getAllByLabelText("Edit comment")).toHaveLength(1);
    expect(slot.getAllByLabelText("Discard comment")).toHaveLength(1);
    // And one place to write the next one, for the same reason.
    expect(
      slot.getAllByRole("button", {
        name: "Comment on shared/patch-slice.ts",
      }),
    ).toHaveLength(1);
  });

  it("keeps an unsent comment editable and discardable", async () => {
    const slot = openReview(
      answerableRpc({
        listReviewDrafts: () => ({ comments: [lineDraft], summary: "" }),
      }),
    );

    fireEvent.click((await slot.findAllByLabelText("Edit comment"))[0]!);
    fireEvent.change(slot.getByLabelText("Comment"), {
      target: { value: "Rewritten" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "saveReviewDraftComment",
        input: {
          id: DRAFT_ID,
          reviewArtifactId: REVIEW_ID,
          anchor: lineDraft.anchor,
          body: "Rewritten",
        },
      }),
    );

    fireEvent.click(slot.getAllByLabelText("Discard comment")[0]!);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "deleteReviewDraftComment",
        input: { id: DRAFT_ID },
      }),
    );
  });
});

/** Records what the hook handed back on each render. */
function ThemeProbe({
  seen,
}: {
  seen: ReturnType<typeof useHostCodeTheme>[];
}) {
  seen.push(useHostCodeTheme());
  return null;
}

describe("the code theme the diffs are rendered with", () => {
  afterEach(() => {
    delete document.documentElement.dataset.bbCodeThemeDark;
    delete document.documentElement.dataset.bbCodeThemeLight;
  });

  it("is the same pair until the host publishes a different one", () => {
    document.documentElement.dataset.bbCodeThemeDark = "night";
    document.documentElement.dataset.bbCodeThemeLight = "day";
    const seen: ReturnType<typeof useHostCodeTheme>[] = [];

    const probe = render(<ThemeProbe seen={seen} />);
    probe.rerender(<ThemeProbe seen={seen} />);

    // Everything the diff renderer is configured with hangs off this object,
    // so a new one each render is a rebuilt configuration each render.
    expect(seen[1]).toBe(seen[0]);

    document.documentElement.dataset.bbCodeThemeDark = "midnight";
    probe.rerender(<ThemeProbe seen={seen} />);

    expect(seen[2]).toEqual({ dark: "midnight", light: "day" });
    expect(seen[2]).not.toBe(seen[1]);
  });

  it("is nothing at all when the host published no themes", () => {
    const seen: ReturnType<typeof useHostCodeTheme>[] = [];

    render(<ThemeProbe seen={seen} />);

    expect(seen[0]).toBeUndefined();
  });
});

function feedbackArtifact(
  reviewArtifactId: string,
  verdict: string,
  createdAt: string,
) {
  return {
    id: `${FEEDBACK_ID}${verdict[0]}`,
    taskId: TASK_ID,
    kind: "review_feedback",
    title: "Human review",
    body: null,
    externalUrl: null,
    attachmentId: null,
    sourceThreadId: null,
    metadata: {
      reviewArtifactId,
      verdict,
      summary: "",
      comments: [],
      headSha: PINNED_SHA,
      targetThreadId: null,
    },
    createdAt,
  };
}

const secondReview = reviewArtifact({
  id: OTHER_REVIEW_ID,
  title: "A second look after the fixes",
  createdAt: "2026-07-16T10:00:00.000Z",
});

describe("review rounds", () => {
  it("opens on the newest round nobody has answered", async () => {
    const slot = openReview(
      answerableRpc({
        listArtifacts: () => ({
          artifacts: [
            reviewArtifact(),
            secondReview,
            feedbackArtifact(REVIEW_ID, "request_changes", "2026-07-15T12:00:00.000Z"),
          ],
        }),
      }),
    );

    await slot.findByText("A second look after the fixes");
    slot.getByText("Round 2 of 2");
    slot.getByText("Unanswered");
  });

  it("falls back to the newest round once every one is answered", async () => {
    const slot = openReview(
      answerableRpc({
        listArtifacts: () => ({
          artifacts: [
            reviewArtifact(),
            secondReview,
            feedbackArtifact(REVIEW_ID, "request_changes", "2026-07-15T12:00:00.000Z"),
            feedbackArtifact(OTHER_REVIEW_ID, "approve", "2026-07-16T12:00:00.000Z"),
          ],
        }),
      }),
    );

    await slot.findByText("A second look after the fixes");
    slot.getByText("Approved");
    expect(slot.container.textContent).not.toContain("Unanswered");
  });

  it("routes to the round the reader picks", async () => {
    const slot = openReview(
      answerableRpc({
        listArtifacts: () => ({ artifacts: [reviewArtifact(), secondReview] }),
      }),
    );

    fireEvent.pointerDown(
      await slot.findByText("Round 2 of 2"),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(await slot.findByText("Round 1"));

    await waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "tasks",
        options: { subPath: `review/TSK-5/${REVIEW_ID}` },
      }),
    );
  });
});

/** The round can only go out once it carries something, so wait for that. */
async function clickSubmitRound(slot: ReturnType<typeof openReview>) {
  const button = (await slot.findByRole("button", {
    name: "Submit review",
  })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe("submitting a round", () => {
  const withOneDraft = (overrides: Record<string, unknown> = {}) =>
    answerableRpc({
      listReviewDrafts: () => ({ comments: [lineDraft], summary: "" }),
      ...overrides,
    });

  it("sends the round to the thread that wrote the review", async () => {
    const slot = openReview(withOneDraft());

    fireEvent.click(await slot.findByRole("button", { name: "Request changes" }));
    await clickSubmitRound(slot);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "submitReviewFeedback",
        input: {
          reviewArtifactId: REVIEW_ID,
          verdict: "request_changes",
          target: { kind: "existing", threadId: THREAD_ID },
        },
      }),
    );
    await slot.findByText(/Sent\./);
  });

  it("preselects the thread that wrote the review, and says which it is", async () => {
    const slot = openReview(withOneDraft());

    const reviewer = await slot.findByRole("button", {
      name: /The reviewing thread/,
    });
    expect(reviewer.getAttribute("aria-pressed")).toBe("true");
    expect(reviewer.textContent).toContain("wrote this review");
    const other = slot.getByRole("button", { name: /A second thread/ });
    expect(other.getAttribute("aria-pressed")).toBe("false");
  });

  it("picks no thread at all when the review's own is not attached", async () => {
    const slot = openReview(
      withOneDraft({
        // The reviewing thread is gone from the task; only a stranger is left.
        listTaskThreads: () => ({
          taskThreads: [taskThread(OTHER_THREAD_ID, "A second thread")],
        }),
      }),
    );

    const other = await slot.findByRole("button", { name: /A second thread/ });
    // Nothing is chosen, because nothing here is the obvious choice: sending
    // to a thread that never touched the work must be someone's decision.
    expect(other.getAttribute("aria-pressed")).toBe("false");
    const submit = (await slot.findByRole("button", {
      name: "Submit review",
    })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    slot.getByText("Choose where this round goes.");

    fireEvent.click(other);

    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "submitReviewFeedback",
        input: {
          reviewArtifactId: REVIEW_ID,
          verdict: "comment",
          target: { kind: "existing", threadId: OTHER_THREAD_ID },
        },
      }),
    );
  });

  it("asks for no thread when the verdict is an approval", async () => {
    const slot = openReview(
      withOneDraft({
        submitReviewFeedback: () => ({
          outcome: "submitted",
          artifactId: FEEDBACK_ID,
          threadId: null,
        }),
      }),
    );

    fireEvent.click(await slot.findByRole("button", { name: "Approve" }));
    expect(slot.queryByText("The reviewing thread")).toBeNull();
    await clickSubmitRound(slot);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "submitReviewFeedback",
        input: {
          reviewArtifactId: REVIEW_ID,
          verdict: "approve",
          target: null,
        },
      }),
    );
    await slot.findByText("Approval recorded on the task.");
  });

  it("can start a fresh thread for the round instead", async () => {
    const slot = openReview(withOneDraft());

    fireEvent.click(await slot.findByRole("button", { name: "New thread" }));
    await clickSubmitRound(slot);

    await waitFor(() =>
      expect(
        slot.rpcCalls,
      ).toContainEqual({
        method: "submitReviewFeedback",
        input: {
          reviewArtifactId: REVIEW_ID,
          verdict: "comment",
          target: { kind: "new" },
        },
      }),
    );
  });

  /**
   * A server that empties the drafts when — and only when — a round actually
   * goes out. Asserting that they survived a failed send is worth nothing
   * against a stub that could not have deleted them either way.
   */
  const submittingRpc = (result: Record<string, unknown>) => {
    let comments: unknown[] = [lineDraft];
    return answerableRpc({
      listReviewDrafts: () => ({ comments, summary: "" }),
      submitReviewFeedback: () => {
        if (result.outcome === "submitted") comments = [];
        return result;
      },
    });
  };

  it("keeps the reviewer's place when the send fails", async () => {
    const slot = openReview(
      submittingRpc({
        outcome: "failed",
        reason: "send_failed",
        message: "The thread is archived.",
      }),
    );

    await clickSubmitRound(slot);

    await slot.findByText(/the thread would not take the message/);
    slot.getByText("The thread is archived.", { exact: false });
    // Ask the server again rather than trusting the paint: the question is
    // what it still holds, not what was on screen before the attempt.
    await slot.emitRealtime("tasks:changed", {});
    await waitFor(() =>
      expect(slot.getAllByText("This line worries me").length).toBeGreaterThan(
        0,
      ),
    );
    // The drafts are still drafts, and the round can be sent somewhere else.
    slot.getByRole("button", { name: "Submit review" });
  });

  it("lets the drafts go once the round has gone out", async () => {
    const slot = openReview(
      submittingRpc({
        outcome: "submitted",
        artifactId: FEEDBACK_ID,
        threadId: THREAD_ID,
      }),
    );

    await clickSubmitRound(slot);

    await slot.findByText(/Sent\./);
    // Sending reads the drafts again, and this time there are none.
    await waitFor(() =>
      expect(slot.queryByText("This line worries me")).toBeNull(),
    );
  });

  it("saves the overall note when the reviewer leaves mid-sentence", async () => {
    const slot = openReview(withOneDraft());

    fireEvent.change(await slot.findByLabelText("Overall note"), {
      target: { value: "Half a thought." },
    });
    // Well inside the debounce window: the note has not been saved yet.
    expect(slot.rpcCalls).not.toContainEqual({
      method: "saveReviewDraftSummary",
      input: { reviewArtifactId: REVIEW_ID, body: "Half a thought." },
    });
    slot.lifecycle.unmount();

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "saveReviewDraftSummary",
        input: { reviewArtifactId: REVIEW_ID, body: "Half a thought." },
      }),
    );
  });

  it("saves the overall note before sending the round", async () => {
    const slot = openReview(withOneDraft());

    fireEvent.change(await slot.findByLabelText("Overall note"), {
      target: { value: "Mostly good." },
    });
    await clickSubmitRound(slot);

    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "saveReviewDraftSummary",
        input: { reviewArtifactId: REVIEW_ID, body: "Mostly good." },
      }),
    );
  });
});
