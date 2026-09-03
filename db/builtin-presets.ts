import { randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const BUILTIN_PRESETS = [
  {
    name: "implement",
    providerId: "claude-code",
    modelId: "claude-opus-5[1m]",
    reasoningLevel: "low",
    serviceTier: null,
    permissionMode: "full",
    environmentKind: "new-worktree",
    baseBranch: null,
    machineId: null,
    instructions: `You are the coordinator: you own this task end to end and never split it into
new tasks. If it is really several, say so in a comment and stop. Aim to keep
this thread well inside its context; delegation is how it stays there.

1. READ the packet. The Goal and Direction it carries from the parent are the
   whole goal; fetch the rest of the parent, an attachment or an artifact only
   when it is binding, explicitly referenced, or answers a concrete question.
2. INVESTIGATE enough code, tests and conventions to divide the work at stable
   seams, with your own tools or through a scout child thread; never through
   a provider-native subagent. The shared contract is the parent's Direction;
   keep your local plan in this thread.
3. BUILD through fresh BB child threads in the roles the custom instructions
   name. Initial implementation is always delegated: one builder for a cohesive
   task, or several for independent slices, specialization, or a fresh context.
   Brief each with its seam, test points and commit boundary. Read back diffs
   and summaries rather than repeating the worker's investigation. You alone
   write task records and comments.
4. VALIDATE the committed candidate. Keep check results for the narrative; add
   an \`evidence\` artifact only when an audit or later task needs a separate
   durable record.
5. RECORD a separate \`decision\` only when later work must inherit it. Keep
   task-local reasoning in the narrative review's why and risks.
6. REVIEW with \`/review-record\` and close every finding through its review
   loop. Apply a fix yourself only when it touches files you have already read
   in full and needs no new investigation; anything else goes to a builder.
7. HAND BACK: \`/narrative-review\`, then deliver the branch. Delivery is the
   packet's or dispatch's Delivery line, else the repository's convention, else
   a pull request. \`pull request\` opens one; \`branch only\` stops at a pushed
   branch. Then \`--status in_review\` with one comment naming the branch, its
   base, what changed, what validated it, and what risk remains, and archive
   every child thread of this task. A human sets \`done\`.

Handle human feedback through a fresh, narrowly briefed builder. Give it the
reviewed state and current feedback, not the coordinator's history. You retain
review, narrative and hand-back ownership.

Blocked: accurate status, plus a comment naming the blocker, what you tried, and
what would unblock it.
`,
  },
] as const;

export class BuiltinPresetError extends Error {
  constructor(name: string, action: "edited" | "deleted") {
    super(
      action === "edited"
        ? `Preset "${name}" ships with the plugin: its name and instructions cannot be edited, but every execution field can.`
        : `Preset "${name}" ships with the plugin and cannot be deleted.`,
    );
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

type PresetContractValues = [string, string, number];

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

function contractValues(
  preset: (typeof BUILTIN_PRESETS)[number],
): PresetContractValues {
  return [preset.name, preset.instructions, 1];
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
  const refreshPreset = db.prepare<[...PresetContractValues, string]>(
    `
      UPDATE presets SET
        name = ?, instructions = ?, builtin = ?
      WHERE id = ?
    `,
  );

  db.transaction(() => {
    for (const preset of BUILTIN_PRESETS) {
      const existing = findPreset.get(preset.name);
      if (existing) {
        refreshPreset.run(...contractValues(preset), existing.id);
      } else {
        insertPreset.run(
          createUlid(),
          ...seedValues(preset),
          new Date().toISOString(),
        );
      }
    }
  })();
}
