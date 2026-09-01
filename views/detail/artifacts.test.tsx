// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// jsdom lacks matchMedia; the vendored Dialog's responsive root needs it.
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

// loadPluginApp installs the fake SDK runtime; nothing SDK-touching may be
// imported before it runs.
const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const PLAN_ID = "01HZZZZZZZZZZZZZZZZZZZZZA1";
const OLD_DECISION_ID = "01HZZZZZZZZZZZZZZZZZZZZZA2";
const NEW_DECISION_ID = "01HZZZZZZZZZZZZZZZZZZZZZA3";
const REVIEW_ID = "01HZZZZZZZZZZZZZZZZZZZZZA4";

const task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Read the engineering record",
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

const approvedPlan = {
  id: PLAN_ID,
  taskId: TASK_ID,
  kind: "approved_plan",
  title: "Approved implementation plan",
  body: "Ship the three readers.",
  externalUrl: "https://example.test/plan",
  attachmentId: null,
  sourceThreadId: null,
  metadata: { approvedBy: "Sawyer", approvedAt: "2026-07-15" },
  createdAt: "2026-07-15T09:00:00.000Z",
};

function decision(id: string, title: string, createdAt: string) {
  return {
    id,
    taskId: TASK_ID,
    kind: "decision",
    title,
    body: `Body of ${title}`,
    externalUrl: null,
    attachmentId: null,
    sourceThreadId: null,
    metadata: {
      discovery: "d",
      decision: "c",
      why: "w",
      impact: "i",
    },
    createdAt,
  };
}

const review = {
  id: REVIEW_ID,
  taskId: TASK_ID,
  kind: "review",
  title: "Narrative review",
  body: "Read it as a document.",
  externalUrl: null,
  attachmentId: null,
  sourceThreadId: null,
  metadata: {
    baseRef: "main",
    headSha: "abc1234",
    environmentId: null,
    concerns: [],
  },
  createdAt: "2026-07-15T12:00:00.000Z",
};

function detailRpc(overrides: Record<string, unknown> = {}) {
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
    getTaskByKey: () => ({ task }),
    listTasks: (input: { parentTaskId?: string } | null) =>
      input?.parentTaskId ? { tasks: [] } : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listArtifacts: () => ({
      artifacts: [
        decision(OLD_DECISION_ID, "Older decision", "2026-07-15T10:00:00.000Z"),
        approvedPlan,
        decision(NEW_DECISION_ID, "Newer decision", "2026-07-15T11:00:00.000Z"),
      ],
    }),
    listTaskThreads: () => ({ taskThreads: [] }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

describe("task detail artifacts section", () => {
  it("lists artifacts grouped by kind, newest first within a kind", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc() },
    );

    await slot.findByText("Approved implementation plan");
    const titles = ["Approved Plan", "Decision", "Decision"];
    const badges = slot
      .getAllByText(/^(Approved Plan|Decision)$/)
      .map((node) => node.textContent);
    expect(badges).toEqual(titles);

    const rendered = slot.container.textContent ?? "";
    expect(rendered.indexOf("Approved implementation plan")).toBeLessThan(
      rendered.indexOf("Newer decision"),
    );
    expect(rendered.indexOf("Newer decision")).toBeLessThan(
      rendered.indexOf("Older decision"),
    );
  });

  it("reveals an artifact's body when its row is clicked", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc() },
    );

    const row = await slot.findByText("Newer decision");
    expect(slot.queryByText("Body of Newer decision")).toBeNull();
    fireEvent.click(row);
    await slot.findByText("Body of Newer decision");
  });

  it("links an artifact that carries an external url", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { openUrl: () => true, rpc: detailRpc() },
    );

    const link = (await slot.findByRole("link", {
      name: "Open Approved implementation plan",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://example.test/plan");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });

  it("omits the section entirely when the task has no artifacts", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc({ listArtifacts: () => ({ artifacts: [] }) }) },
    );

    await slot.findByText("Read the engineering record");
    expect(slot.queryByText("Artifacts")).toBeNull();
  });
});

describe("artifact review launcher", () => {
  const withReview = () =>
    detailRpc({
      listArtifacts: () => ({
        artifacts: [
          decision(
            OLD_DECISION_ID,
            "Older decision",
            "2026-07-15T10:00:00.000Z",
          ),
          approvedPlan,
          review,
        ],
      }),
    });

  it("navigates to the review route for that exact artifact", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: withReview() },
    );

    const open = await slot.findByRole("button", {
      name: "Open review Narrative review",
    });
    fireEvent.click(open);
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "tasks",
      options: { subPath: `review/TSK-5/${REVIEW_ID}` },
    });
  });

  it("leaves rows of other kinds without the control", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: withReview() },
    );

    await slot.findByText("Narrative review");
    expect(
      slot.queryByRole("button", {
        name: "Open review Approved implementation plan",
      }),
    ).toBeNull();
    expect(slot.getAllByText("Open review")).toHaveLength(1);
  });
});
