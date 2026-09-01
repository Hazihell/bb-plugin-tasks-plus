// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// loadPluginApp installs the fake SDK runtime; nothing SDK-touching may be
// imported before it runs.
const app = await loadPluginApp(() => import("../../app"));

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
