import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const BUILTIN_PRESETS = [
  {
    name: "implement",
    providerId: "claude-code",
    modelId: "claude-opus-5[1m]",
    reasoningLevel: "medium",
    serviceTier: null,
    permissionMode: "full",
    environmentKind: "new-worktree",
    baseBranch: null,
    machineId: null,
    instructions: `You are the working thread: you own this task end to end and never split it into
new tasks. If it is really several, say so in a comment and stop.

1. READ. The task, its parent, its blockers, every attachment, every artifact. A
   recorded plan or decision outranks your reading of the description.
2. INVESTIGATE the code, its tests and its conventions before planning.
3. PLAN as an \`implementation_plan\` artifact before code exists: files, seams,
   test points, what is out of scope. Meta: \`approvedBy\`, \`approvedAt\`.
4. BUILD test-first at the seams the plan named: a failing test, then the code
   that passes it, then the commit. Subagents are execution — investigation, an
   isolated slice, a suite run — never task decomposition; you alone write
   artifacts and comments.
5. EVIDENCE as each check runs, failures included: an \`evidence\` artifact with
   \`command\`, \`exitCode\`, \`evidenceKind\`.
6. DECISIONS, material ones only (\`discovery\`, \`decision\`, \`why\`, \`impact\`):
   behaviour that contradicts the task, architecture, data model, a dependency,
   a contract or public surface, security, performance, a deviation from the
   approved direction. A rename, an extracted local function, a moved file, a
   reformat is a detail — leave it to the diff. Zero to three per task is
   normal.
7. REVIEW with \`/review-record\` against the committed sha, and close every
   finding with a fix or a written reason it needs none.
8. HAND BACK: \`/narrative-review\`, open a PR, then \`--status in_review\` with one
   comment saying what changed, what validated it, and what risk remains. A human
   sets \`done\`.

Blocked: accurate status, plus a comment naming the blocker, what you tried, and
what would unblock it.
`,
  },
] as const;

export class BuiltinPresetError extends Error {
  constructor(name: string, action: "edited" | "deleted") {
    super(`Preset "${name}" ships with the plugin and cannot be ${action}.`);
    this.name = "BuiltinPresetError";
  }
}

function createUlid(): string {
  let random = 0n;
  for (const byte of randomBytes(10)) random = (random << 8n) | BigInt(byte);
  let value = (BigInt(Date.now()) << 80n) | random;

  let id = "";
  for (let index = 0; index < 26; index += 1) {
    id = ULID_ALPHABET[Number(value & 31n)] + id;
    value >>= 5n;
  }
  return id;
}

type PresetSeedValues = [
  string,
  string,
  string,
  string,
  string | null,
  string,
  string,
  string | null,
  string | null,
  string,
  number,
];

function seedValues(preset: (typeof BUILTIN_PRESETS)[number]): PresetSeedValues {
  return [
    preset.name,
    preset.providerId,
    preset.modelId,
    preset.reasoningLevel,
    preset.serviceTier,
    preset.permissionMode,
    preset.environmentKind,
    preset.baseBranch,
    preset.machineId,
    preset.instructions,
    1,
  ];
}

export function seedBuiltinPresets(db: PluginDatabase): void {
  const findPreset = db.prepare<[string], { id: string }>(
    "SELECT id FROM presets WHERE name = ? COLLATE NOCASE",
  );
  const insertPreset = db.prepare<
    [string, ...PresetSeedValues, string]
  >(
    `
      INSERT INTO presets (
        id, name, provider_id, model_id, reasoning_level, service_tier,
        permission_mode, environment_kind, base_branch, machine_id,
        instructions, builtin, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
  const refreshPreset = db.prepare<[...PresetSeedValues, string]>(
    `
      UPDATE presets SET
        name = ?, provider_id = ?, model_id = ?, reasoning_level = ?,
        service_tier = ?, permission_mode = ?, environment_kind = ?,
        base_branch = ?, machine_id = ?, instructions = ?, builtin = ?
      WHERE id = ?
    `,
  );

  db.transaction(() => {
    for (const preset of BUILTIN_PRESETS) {
      const existing = findPreset.get(preset.name);
      const values = seedValues(preset);
      if (existing) {
        refreshPreset.run(...values, existing.id);
      } else {
        insertPreset.run(createUlid(), ...values, new Date().toISOString());
      }
    }
  })();
}
