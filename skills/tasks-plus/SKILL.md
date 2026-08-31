---
name: tasks-plus
description: This user's issue tracker. Use when working on or tracking a task, when a prompt mentions a task key such as ABC-12, or when another skill refers to "the issue tracker" — publishing or fetching an issue, spec or ticket, breaking a plan into tickets, applying triage labels, or recording parent and blocked-by relationships.
---

Use the `bb tasks-plus` CLI to understand the assigned task, keep its record useful, and report the outcome where the work is tracked.

## Presets

Dispatch requires a preset. `implement` ships with the plugin and is the default choice; the rest are yours. `bb tasks-plus preset list` shows them, and `preset create`/`preset update` take the same execution fields the Tasks UI exposes:

```sh
bb tasks-plus preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast --permission auto
```

`--service-tier none` clears a tier.

A preset's instructions ride on every seed prompt it dispatches, so a working thread's lifecycle belongs in the preset rather than in each task description. The shipped `implement` preset is that lifecycle: one thread owns the task end to end — read, investigate, plan as an artifact, build test-first, evidence and decisions as it goes, `/review-record`, `/narrative-review`, PR, `in_review` — and never splits it into new tasks. It names only skills this plugin bundles, so it works on an install with no personal skills.

The plugin owns that preset's name and instructions: seeded on first open, restored on every later open, refused for editing or deletion. Provider, model, reasoning, permission and environment stay yours to change and survive every refresh. `bb tasks-plus preset show implement` prints the live text.

## Work a task

1. Read the task before acting. Alongside the description and record, the detail carries the GitHub pull requests the attached threads produced, with state, read from environment metadata. Use `--json` when the result will drive commands or code.

   ```sh
   bb tasks-plus show ABC-12
   ```

   For project-wide discovery, `bb tasks-plus list` returns at most 100 rows; pass `--limit 1-500`, and in JSON continue with `nextCursor` via `--cursor <value>` under the same filters and sort. Any task-list mutation makes a cursor stale, so restart without it.

2. Fetch every relevant attachment before making assumptions about it:

   ```sh
   bb tasks-plus attachment get <attachment-id> --out <path>
   ```

3. Do the work, commenting once at each meaningful milestone — a completed investigation, an implementation ready for validation, a concrete blocker. Say what changed or was learned, what validation ran, and what risk or blocker remains.

   ```sh
   bb tasks-plus comment ABC-12 --body "Implemented the change; focused validation now passes."
   ```

   `--notify` also delivers the comment to the thread that wrote the task's most recent agent reply, resuming it if idle; with no prior agent reply it is simply recorded. The new comment keeps the current thread's identity and its explicit `--author`, while delivery still targets that prior responder.

4. Attach result artifacts that belong with the task — reports, screenshots, patches, logs, generated files.

   A task key attaches at task level:

   ```sh
   bb tasks-plus attachment add ABC-12 --file ./report.md
   ```

   A comment ID attaches to that comment, for a file belonging with one milestone note. Create the comment with `--json`, capture `.comment.id`, then attach:

   ```sh
   comment_id=$(
     bb tasks-plus comment ABC-12 --body "Screenshot of the failing step." \
       --json | jq -r '.comment.id'
   )
   bb tasks-plus attachment add "$comment_id" --file ./screenshot.png
   ```

   A task that should start with files takes repeatable `--attach <path>` on `bb tasks-plus create` instead. `bb tasks-plus attachment list <key>` gives the ids that `bb tasks-plus attachment remove <attachment-id>` takes, deleting row and blob together. A referenced attachment is refused until the caller confirms content cleanup with `--remove-references`, which also drops the saved description image reference.

   File paths (`--file`, `--attach`, `--out`, `--description-file`, `--body-file`, `--meta-file`) are read and written on the invoking machine: the thread's machine inside an agent thread, so local paths just work; the server's machine outside one. `--machine <id-or-name>` addresses another enrolled machine.

5. When implementation is complete and awaiting human or agent review:

   ```sh
   bb tasks-plus update ABC-12 --status in_review
   ```

   Where the work cannot proceed, leave the status accurate and comment with the specific blocker, what you tried, and what would unblock it. Reserve `done` for a task whose completion criteria are met.

6. Delegated threads attach automatically. A thread that arrived another way attaches itself so the task shows the active work, and detaches when it is finished with the task — a hand-off, a respawned replacement, a dead predecessor — so `bb tasks-plus threads ABC-12` stays accurate. `detach` without `--thread` detaches the current one.

   ```sh
   bb tasks-plus attach ABC-12
   bb tasks-plus detach ABC-12 --thread thr_dead_predecessor
   ```

## Artifacts

Comments narrate; artifacts are the durable record. Add one whenever the work produces something a later reader must be able to trust.

```sh
bb tasks-plus artifact add ABC-12 --kind evidence \
  --title "CLI suite passes" --meta-file /tmp/evidence.json
```

`--meta-file` is required and holds a JSON object — a file, never shell-quoted JSON — whose fields depend on the kind:

- `approved_plan`, `implementation_plan` — `approvedBy`, `approvedAt` (`YYYY-MM-DD`)
- `decision` — `discovery`, `decision`, `why`, `impact`
- `evidence` — `command`, `exitCode`, `evidenceKind` (`unit`, `integration`, `e2e`, `contract`, `static`, `type`, `architecture`, `benchmark`, `security`, `manual`)
- `review` — `baseRef`, `headSha`, `environmentId`, `concerns`
- `review_result` — `verdict` (`pass`/`fail`/`mixed`), `findingCounts`

Add `--body` or `--body-file` for the narrative, `--url` for an external link, and `--attach <path>` to store a payload alongside the artifact in one call. Run inside an agent thread and the artifact records which thread wrote it.

```sh
bb tasks-plus artifact list ABC-12 --kind decision --kind evidence
bb tasks-plus artifact show <artifact-id>
bb tasks-plus artifact remove <artifact-id>
```

Artifacts are append-only: there is no edit. A record that turned out wrong is removed and re-added, or superseded by a later one that says so.

## Blockers and hierarchy

A task is blocked when it has an unresolved blocker — another task not yet `done` or `canceled`. Blocked is derived, never stored, so closing or cancelling the blocker unblocks the dependent immediately and there is no unblock action.

```sh
bb tasks-plus blocker add ABC-12 ABC-9   # ABC-12 is blocked by ABC-9
bb tasks-plus blocker rm ABC-12 ABC-9
bb tasks-plus blocker list ABC-12        # both directions: blocked by, and blocking
```

Blocking is enforced, not advisory: a blocked task refuses `--status in_progress` and refuses `dispatch`. Cycles are rejected as the edge is written. Resolved blockers stay in the list, which is the record of what held the task up.

Blockers are orthogonal to `--parent`. A parent groups work; a blocker orders it, and may live in another project. Set hierarchy with `bb tasks-plus update ABC-12 --parent ABC-10` (key or ID) and `--no-parent` to promote a subtask to the top level; the two flags cannot be combined.

## Use as the project issue tracker

Skills that speak of "the issue tracker", "publishing an issue", "fetching a ticket", or triage labels mean Tasks Plus — unless the repo carries its own `docs/agents/issue-tracker.md`, which wins where it exists. An issue number is a task key such as `ABC-12`.

Two things a skill writes as prose are relations here, and the relation is the record:

- a **Parent** section → `--parent <key>` on create
- a **Blocked by** section → `bb tasks-plus blocker add <task> <blocker>`

So create parents before children and blockers before dependents, capturing each new key with `--json | jq -r '.task.key'`.

The five triage roles — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — are labels. Statuses track the work itself and drive blocker resolution, so they stay free of triage state. Create a missing label with `bb tasks-plus label create --project <prefix> --name <name>`.

## Link tasks in responses

When your answer refers the user to a task, including one you just created, emit this leaf directive on its own line rather than writing the key as plain text:

```md
::task{key="ABC-12"}
```

`key` is required; optional `title="…"` is the display fallback shown while the card loads and when the key no longer resolves. The card shows live status, title and priority, opens the task in the thread side panel, and links to the full Tasks app. One directive per line, one card each.

## Invariants

- Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`.
- One comment per meaningful milestone, combining related facts into a single useful update.
- Prefer stable task keys such as `ABC-12` for task commands.
