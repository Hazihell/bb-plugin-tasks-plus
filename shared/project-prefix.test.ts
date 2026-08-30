import { describe, expect, it } from "vitest";

import {
  derivePrefix,
  deriveUniquePrefix,
  PROJECT_PREFIX_PATTERN,
} from "./project-prefix.js";

describe("project prefixes", () => {
  it("derives the plain suggestion independently of existing projects", () => {
    expect(derivePrefix("Tasks Plugin")).toBe("TP");
    expect(derivePrefix("Connect")).toBe("CON");
    expect(derivePrefix("123")).toBe("");
  });

  it("adds a collision suffix and falls back for an empty suggestion", () => {
    expect(deriveUniquePrefix("Tasks Plugin", [{ prefix: "TP" }])).toBe(
      "TP2",
    );
    const fallback = deriveUniquePrefix("123", []);
    expect(fallback).toBe("P");
    expect(PROJECT_PREFIX_PATTERN.test(fallback)).toBe(true);
  });
});
