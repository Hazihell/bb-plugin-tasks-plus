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

/**
 * The publish sequence is the part of `to-spec-and-design` an agent copies
 * verbatim, and the relations it records only survive if the order holds:
 * a parent exists before a child can point at it, and both exist before an
 * edge can join them. Pinning the order in the doc is pinning the behaviour.
 */
describe("the to-spec-and-design publish sequence", () => {
  const source = readSkill("to-spec-and-design");
  // Shell line continuations are one command, so rejoin them before matching.
  const joined = source.replace(/\\\n\s*/g, " ");
  const commands = [
    ...joined.matchAll(/^\s*(?:\w+=\$\()?bb tasks-plus .+$/gm),
  ].map((match) => match[0].trim());

  const parentCreate = commands.findIndex(
    (command) => /\bcreate\b/.test(command) && !command.includes("--parent"),
  );
  const childCreate = commands.findIndex(
    (command) => /\bcreate\b/.test(command) && command.includes("--parent"),
  );
  const blockerAdd = commands.findIndex((command) =>
    command.includes("blocker add"),
  );

  it("documents creating a child under a parent", () => {
    expect(childCreate).toBeGreaterThanOrEqual(0);
  });

  it("documents joining slices with a real blocker edge", () => {
    expect(blockerAdd).toBeGreaterThanOrEqual(0);
  });

  it("creates the parent, then children, then the edges between them", () => {
    expect(parentCreate).toBeLessThan(childCreate);
    expect(childCreate).toBeLessThan(blockerAdd);
  });

  it("attaches the design to the task it created", () => {
    expect(source).toMatch(/attachment add .*--name approved-plan\.md/);
  });
});

/**
 * Every command a skill hands an agent has to be one the CLI answers to.
 * Reading the verbs off the CLI's own registration keeps the examples
 * non-fictional and fails loudly if a command is ever renamed.
 */
describe("commands the skills tell agents to run", () => {
  const cli = readFileSync(join(skillsDir, "..", "cli", "index.ts"), "utf8");

  const documented = skillNames.flatMap((name) =>
    [...readSkill(name).matchAll(/\bbb tasks-plus ([a-z-]+)/g)].map(
      (match) => match[1] ?? "",
    ),
  );

  it.each([...new Set(documented)].sort())(
    "%s is a command the CLI registers",
    (command) => {
      expect(cli).toMatch(new RegExp(`bb tasks-plus ${command}\\b`));
    },
  );
});
