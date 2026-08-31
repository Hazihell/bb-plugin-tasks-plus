import { describe, expect, it } from "vitest";
import {
  formatArtifactManifest,
  type ManifestArtifact,
} from "./artifact-manifest.js";

function artifact(
  id: string,
  overrides: Partial<ManifestArtifact> = {},
): ManifestArtifact {
  return {
    id: `01J0000000000000000000${id}`,
    kind: "decision",
    title: `Artifact ${id}`,
    createdAt: "2026-07-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("artifact manifest", () => {
  it("reads None. when the task has no artifacts", () => {
    expect(formatArtifactManifest("TP-5", [])).toBe("None.");
  });

  it("groups by kind in contract order, newest first, with fetch commands", () => {
    expect(
      formatArtifactManifest("TP-5", [
        artifact("01", {
          kind: "decision",
          title: "Store owns ordering",
          createdAt: "2026-07-15T09:00:00.000Z",
        }),
        artifact("02", {
          kind: "approved_plan",
          title: "Approved implementation plan",
        }),
        artifact("03", {
          kind: "decision",
          title: "Formatter owns the cap",
          createdAt: "2026-07-15T11:00:00.000Z",
        }),
      ]),
    ).toBe(
      `### Approved Plan
- Approved implementation plan · 01J000000000000000000002
  Fetch with: bb tasks-plus artifact show 01J000000000000000000002

### Decision
- Formatter owns the cap · 01J000000000000000000003
  Fetch with: bb tasks-plus artifact show 01J000000000000000000003
- Store owns ordering · 01J000000000000000000001
  Fetch with: bb tasks-plus artifact show 01J000000000000000000001`,
    );
  });

  it("breaks a createdAt tie on the id, newest id first", () => {
    const manifest = formatArtifactManifest("TP-5", [
      artifact("0A", { title: "Earlier id" }),
      artifact("0B", { title: "Later id" }),
    ]);
    expect(manifest.indexOf("Later id")).toBeLessThan(
      manifest.indexOf("Earlier id"),
    );
  });

  it("caps each kind at ten lines and names the kind in the remainder", () => {
    const decisions = Array.from({ length: 13 }, (_, index) =>
      artifact(String(index).padStart(2, "0"), {
        title: `Decision ${index}`,
        createdAt: `2026-07-15T${String(index).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const manifest = formatArtifactManifest("TP-5", [
      ...decisions,
      artifact("99", { kind: "evidence", title: "Suite green" }),
    ]);

    expect(manifest.match(/Fetch with:/g)).toHaveLength(11);
    expect(manifest).toContain(
      "… and 3 more — bb tasks-plus artifact list TP-5 --kind decision",
    );
    // The newest ten survive the cap; the oldest three are what it swallows.
    expect(manifest).toContain("Decision 12");
    expect(manifest).not.toContain("Decision 2 ·");
    // A kind under the cap gets no remainder line of its own.
    expect(manifest.match(/… and/g)).toHaveLength(1);
  });
});
