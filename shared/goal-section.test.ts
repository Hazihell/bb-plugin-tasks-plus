import { describe, expect, it } from "vitest";
import { extractGoalSection } from "./goal-section";

describe("extractGoalSection", () => {
  it("returns the Goal section body up to the next heading", () => {
    const description = [
      "# Title",
      "",
      "## Goal",
      "",
      "Ship the thing.",
      "",
      "Delivery: branch only",
      "",
      "## User Stories",
      "",
      "1. As a user…",
    ].join("\n");
    expect(extractGoalSection(description)).toBe(
      "Ship the thing.\n\nDelivery: branch only",
    );
  });

  it("keeps deeper headings inside the Goal section", () => {
    expect(
      extractGoalSection("## Goal\n\nOne.\n\n### Detail\n\nTwo.\n\n## Next\n\nNo."),
    ).toBe("One.\n\n### Detail\n\nTwo.");
  });

  it("falls back to the first paragraph without a Goal heading", () => {
    expect(extractGoalSection("First para\nstill first.\n\nSecond.")).toBe(
      "First para\nstill first.",
    );
  });

  it("returns an empty string for a blank description", () => {
    expect(extractGoalSection("   \n\n")).toBe("");
  });
});
