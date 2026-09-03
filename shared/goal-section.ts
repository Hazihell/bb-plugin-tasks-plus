/**
 * The part of a parent task's description that rides eagerly in every child's
 * dispatch packet: the `## Goal` section when the spec has one, else the first
 * paragraph. Everything else about the parent is fetched on demand.
 */
export function extractGoalSection(description: string): string {
  const lines = description.split("\n");
  const start = lines.findIndex((line) => /^##\s+Goal\s*$/i.test(line));
  if (start !== -1) {
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^##\s/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  }
  const trimmed = description.trim();
  if (trimmed === "") return "";
  return trimmed.split(/\n\s*\n/)[0]?.trim() ?? "";
}
