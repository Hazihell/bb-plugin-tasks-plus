/** Mirrors the contract's project prefix rule (shared/contract.ts). */
export const PROJECT_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,9}$/;

/**
 * Suggest a project prefix from its name: initials for multi-word names,
 * the first three letters otherwise. Must satisfy PROJECT_PREFIX_PATTERN,
 * so leading digits are dropped.
 */
export function derivePrefix(name: string): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const raw =
    words.length >= 2
      ? words.map((word) => word[0]).join("")
      : (words[0] ?? "").slice(0, 3);
  return raw.replace(/^[0-9]+/, "").slice(0, 10);
}

export function deriveUniquePrefix(
  name: string,
  projects: readonly { prefix: string }[],
): string {
  let base = derivePrefix(name);
  if (!PROJECT_PREFIX_PATTERN.test(base)) base = "P";

  const used = new Set(projects.map((project) => project.prefix));
  if (!used.has(base)) return base;
  for (let number = 2; number < 10_000; number += 1) {
    const suffix = String(number);
    const candidate = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`could not derive a unique prefix from ${name}`);
}
