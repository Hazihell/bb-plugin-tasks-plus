import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_PRESETS } from "../db/builtin-presets.js";
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

  it("documents creating a task, a child under it, and an edge", () => {
    expect(parentCreate).toBeGreaterThanOrEqual(0);
    expect(childCreate).toBeGreaterThanOrEqual(0);
    expect(blockerAdd).toBeGreaterThanOrEqual(0);
  });

  it("creates the parent, then children, then the edges between them", () => {
    expect(parentCreate).toBeLessThan(childCreate);
    expect(childCreate).toBeLessThan(blockerAdd);
  });

  it("attaches the design to the task it created", () => {
    expect(source).toMatch(/attachment add .*--name approved-plan\.md/);
  });

  /**
   * A blocker edge names both of its ends by key, and those keys only exist
   * because an earlier create captured them. A doc that names an end it never
   * captured describes a sequence that cannot run. Titles and file paths are
   * the agent's own inputs, so only captured keys are held to this.
   */
  it("names blocker ends that an earlier command captured", () => {
    const script = [...joined.matchAll(/```sh\n([\s\S]*?)```/g)]
      .map((match) => match[1] ?? "")
      .join("\n");
    const captured = new Set<string>();
    const ends: string[] = [];
    for (const line of script.split("\n")) {
      if (line.includes("blocker add")) {
        for (const [, name] of line.matchAll(/"\$(\w+)"/g)) {
          ends.push(name ?? "");
          expect(captured, `${name} is used before it is captured`).toContain(
            name,
          );
        }
      }
      const capture = /^\s*(\w+)=\$\(bb tasks-plus/.exec(line);
      if (capture?.[1] !== undefined) captured.add(capture[1]);
    }
    expect(ends.length).toBe(2);
  });

  /** The single-slice path is the behaviour this change promised not to move. */
  it("still labels a lone task ready-for-agent", () => {
    expect(commands[parentCreate]).toContain("--label ready-for-agent");
  });
});

/**
 * Every command a skill hands an agent has to be one the CLI answers to.
 * Reading the verbs off the CLI's own usage strings keeps the examples
 * non-fictional and fails loudly if a command is ever renamed. Grouped
 * commands are checked to their subcommand, so `blocker nonsense` fails.
 */
describe("commands the skills tell agents to run", () => {
  const cli = readFileSync(join(skillsDir, "..", "cli", "index.ts"), "utf8");

  const isGroup = (verb: string) =>
    new RegExp(`bb tasks-plus ${verb} [a-z]`).test(cli);

  const documented = skillNames.flatMap((name) =>
    [...readSkill(name).matchAll(/\bbb tasks-plus ([a-z-]+)(?: ([a-z-]+))?/g)]
      .map(([, verb = "", sub = ""]) =>
        isGroup(verb) && sub !== "" ? `${verb} ${sub}` : verb,
      )
      .filter((command) => command !== ""),
  );

  it.each([...new Set(documented)].sort())(
    "%s is a command the CLI registers",
    (command) => {
      expect(cli).toMatch(new RegExp(`bb tasks-plus ${command}\\b`));
    },
  );
});

/**
 * A preset instruction is executed by a model, so a skill the preset names must
 * be one a model may invoke. `disable-model-invocation` blocks every model call,
 * not just a spontaneous one, so setting it on a step the preset requires makes
 * the plugin's own workflow unrunnable — which is exactly what happened once.
 */
describe("skills the builtin presets tell a worker to run", () => {
  const required = [
    ...new Set(
      BUILTIN_PRESETS.flatMap((preset) =>
        [...preset.instructions.matchAll(/`\/([a-z-]+)`/g)].map(
          ([, name]) => name ?? "",
        ),
      ),
    ),
  ]
    .filter((name) => skillNames.includes(name))
    .sort();

  it("names at least one shipped skill", () => {
    expect(required.length).toBeGreaterThan(0);
  });

  it.each(required)("%s does not refuse model invocation", (name) => {
    expect(frontmatterField(readSkill(name), "disable-model-invocation")).toBe(
      undefined,
    );
  });
});
