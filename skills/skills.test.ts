import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tasksRpcContract } from "../shared/contract.js";

const skillsDir = dirname(fileURLToPath(import.meta.url));

function readSkill(name: string): string {
  return readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
}

const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * The frontmatter is the context pointer that decides whether a skill is ever
 * reached, so its two load-bearing fields are worth pinning for every skill the
 * plugin ships.
 */
function frontmatterField(source: string, field: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
  if (frontmatter === undefined) return undefined;
  const line = new RegExp(`^${field}:[ \\t]*(.+)$`, "m").exec(frontmatter)?.[1];
  return line?.trim().replace(/^"(.*)"$/s, "$1");
}

describe("shipped skills", () => {
  it("ships at least the three documented skills", () => {
    expect(skillNames).toContain("narrative-review");
    expect(skillNames).toContain("tasks-plus");
    expect(skillNames).toContain("to-spec-and-design");
  });

  it.each(skillNames)("%s declares a name matching its directory", (name) => {
    const source = readSkill(name);
    expect(frontmatterField(source, "name")).toBe(name);
    expect(frontmatterField(source, "description")).toBeTruthy();
  });
});

/**
 * The skill documents a metadata example an agent will copy. Parsing it with
 * the same schema the CLI writes through keeps the example non-fictional, and
 * fails loudly if the contract ever moves out from under the skill.
 */
describe("the narrative-review worked example", () => {
  const source = readSkill("narrative-review");
  const jsonBlocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );

  it("is exactly one fenced json block", () => {
    expect(jsonBlocks).toHaveLength(1);
  });

  const metadata: unknown = JSON.parse(jsonBlocks[0] ?? "null");

  it("parses as review artifact metadata", () => {
    const parsed = tasksRpcContract.createArtifact.input.safeParse({
      taskId: "01JQ8Z3K7M4N5P6R7S8T9VWXYZ",
      title: "A narrative review",
      kind: "review",
      metadata,
    });
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it("groups concerns by behaviour rather than by file", () => {
    const titles = (metadata as { concerns: { title: string }[] }).concerns.map(
      (concern) => concern.title,
    );
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title).not.toMatch(/\.tsx?$|\//);
    }
  });
});
