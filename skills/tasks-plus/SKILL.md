---
name: tasks-plus
description: Tasks Plus is this user's issue tracker. Use when asked to work on or track a task, when the prompt mentions a task key such as ABC-12, when work needs task comments, attachments, delegation tracking, or status updates, and whenever another skill refers to "the issue tracker" — publishing or fetching an issue, spec, PRD, or ticket, breaking a plan into tickets, applying triage labels, or recording parent and blocked-by relationships.
---

# Tasks

Use the `bb tasks-plus` CLI to understand the assigned task, keep its record useful,
and report the outcome where the work is tracked.

Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb tasks-plus preset list` and create a preset if the required one does
not already exist. Dispatch requires an existing preset.

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier default|fast|none`:

```sh
bb tasks-plus preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--service-tier none` clears a tier.

### The implement preset

A preset's `--instructions` are appended to every seed prompt it dispatches, so
the preset is where a working thread's lifecycle is defined, not the task
description. The `implement` preset carries the standard contract: the dispatched
thread owns the task end to end and never decomposes it into new tasks.

1. Read the task, its parent, and every blocker; fetch the attachments and read
   the artifacts before forming an opinion.
2. Investigate the code before planning.
3. Record the plan as an `implementation_plan` artifact before any code exists.
4. Call `/implement` — it already guarantees `/tdd` at pre-agreed seams,
   `/code-review`, and a commit. Subagents are for execution inside it, never for
   splitting the task; only the working thread writes artifacts and comments.
5. Record each meaningful check as an `evidence` artifact as it runs, failures
   included.
6. Record material discoveries as `decision` artifacts — behaviour, architecture,
   data model, dependencies, contracts, security, performance, and any deviation
   from the approved direction. A rename or an extracted local function is not
   one.
7. Run `/narrative-review` against the landed commit, then open a PR.
8. Set `in_review` with one closing comment; a human sets `done`.

Change the contract with `bb tasks-plus preset update implement --instructions
<text>`, and check it by dispatching a throwaway task and reading the seed prompt
in the spawned thread's log.

## Work a task

1. Find and read the task before acting:

   ```sh
   bb tasks-plus show ABC-12
   ```

   The detail includes the description, status, priority, labels, subtasks,
   comments, attachments, attached worker threads, and the GitHub pull
   requests those threads produced (from environment metadata, with state
   open/draft/merged/closed). Use
   `bb tasks-plus show ABC-12 --json` when the result will drive commands or code.

   For project-wide discovery, `bb tasks-plus list` returns at most 100 rows by
   default. Pass `--limit 1-500`; in JSON, continue with `nextCursor` via the
   same filters/sort and `--cursor <value>`. A task-list mutation makes an old
   cursor stale, so restart without it.

2. Fetch every relevant attachment before making assumptions about it:

   ```sh
   bb tasks-plus attachment get <attachment-id> --out <path>
   ```

3. Do the work. Post one substantive comment at each meaningful milestone,
   such as a completed investigation, an implementation ready for validation,
   or a concrete blocker:

   ```sh
   bb tasks-plus comment ABC-12 --body "Implemented the change; focused validation now passes."
   ```

   Add `--notify` only when the new comment should be delivered to the thread
   that authored the task's most recent agent reply. This resumes an idle
   recipient; with no prior agent reply, the comment is recorded without
   targeting an unrelated thread. In agent context, the new comment keeps the
   current thread identity and an explicit `--author`, while delivery still
   targets the prior latest responder rather than the new comment itself.

4. Attach result artifacts that belong with the task, such as reports,
   screenshots, patches, or generated files. `--file` accepts images and
   other files (for example `.png`, `.jpg`, `.svg`, `.pdf`, `.md`, `.patch`,
   or logs).

   **Task-level attachment** — pass the task key so the file sits on the
   task itself:

   ```sh
   bb tasks-plus attachment add ABC-12 --file ./report.md
   bb tasks-plus attachment add ABC-12 --file ./screenshot.png
   ```

   **Comment-level attachment** — pass a comment ID so the file sits on that
   comment (for example a screenshot that belongs with a specific milestone
   note). Create the comment with `--json`, capture `.comment.id`, then add
   the attachment:

   ```sh
   comment_id=$(
     bb tasks-plus comment ABC-12 \
       --body "Screenshot of the failing step." \
       --json | jq -r '.comment.id'
   )
   bb tasks-plus attachment add "$comment_id" --file ./screenshot.png
   bb tasks-plus attachment add "$comment_id" --file ./trace.log
   ```

   A task key attaches at task level; a comment ID attaches to that comment.
   Do not pass a task key when the file should hang off a comment. Use
   `--json` when capturing the returned attachment metadata. When creating a
   task that should start with files, pass repeatable `--attach <path>` to
   `bb tasks-plus create` instead of attaching afterwards. Remove an attachment by
   id with `bb tasks-plus attachment remove <attachment-id>` (row and blob are
   deleted together); reuse the ids from `bb tasks-plus attachment list <key>`.
   Referenced attachments are rejected unless the caller explicitly confirms
   content cleanup with `--remove-references`; that flag removes the saved
   description image reference together with the row and blob.

   File paths (`--file`, `--attach`, `--out`, `--description-file`,
   `--body-file`, `--meta-file`) are read from and written to the invoking
   machine: inside
   an agent thread that is the thread's machine, so local paths just work.
   Outside a thread they target the server's machine; pass
   `--machine <id-or-name>` to address files on another enrolled machine.

5. When the work is ready for review, update the task:

   ```sh
   bb tasks-plus update ABC-12 --status in_review
   ```

   Change task hierarchy with `bb tasks-plus update ABC-12 --parent ABC-10`, using
   either a task key or ID for the parent. Promote a subtask to the top level
   with `bb tasks-plus update ABC-12 --no-parent`; the two parent flags cannot be
   combined.

   If the work cannot proceed, leave the status accurate and comment with the
   specific blocker, what you tried, and what would unblock it. Do not mark a
   blocked task complete.

6. Delegated threads are attached automatically. If this thread was not
   delegated from Tasks, attach it yourself so the task shows the active work:

   ```sh
   bb tasks-plus attach ABC-12
   ```

   When a thread is done with a task (hand-off, respawned replacement, or a
   predecessor that died), detach it so `bb tasks-plus threads ABC-12` stays
   accurate. Omit `--thread` to detach the current thread:

   ```sh
   bb tasks-plus detach ABC-12 --thread thr_dead_predecessor
   ```

## Artifacts

Comments narrate; artifacts are the durable record. Attach one whenever the
work produces something a later reader must be able to trust: an approved or
implementation plan, a decision, evidence that a check ran, a review, or a
review result.

```sh
bb tasks-plus artifact add ABC-12 --kind evidence \
  --title "CLI suite passes" --meta-file /tmp/evidence.json
```

`--meta-file` is required and holds a JSON object whose fields depend on the
kind — pass a file, not shell-quoted JSON:

- `approved_plan`, `implementation_plan` — `approvedBy`, `approvedAt`
  (`YYYY-MM-DD`)
- `decision` — `discovery`, `decision`, `why`, `impact`
- `evidence` — `command`, `exitCode`, `evidenceKind` (`unit`, `integration`,
  `e2e`, `contract`, `static`, `type`, `architecture`, `benchmark`,
  `security`, `manual`)
- `review` — `baseRef`, `headSha`, `environmentId`, `concerns`
- `review_result` — `verdict` (`pass`/`fail`/`mixed`), `findingCounts`

Add `--body <markdown>` or `--body-file <path>` for the narrative, `--url` for
an external link, and `--attach <path>` to store a payload — a log, a diff, a
report — alongside the artifact in one call. Run inside an agent thread and the
artifact records which thread wrote it.

```sh
bb tasks-plus artifact list ABC-12 --kind decision --kind evidence
bb tasks-plus artifact show <artifact-id>
bb tasks-plus artifact remove <artifact-id>
```

Artifacts are append-only: there is no edit. A record that turned out wrong is
removed and re-added, or superseded by a later one that says so.

## Blockers

A task is blocked when it has an unresolved blocker — another task that is not
yet `done` or `canceled`. Blocked is derived, never stored: closing or
cancelling the blocker unblocks the dependent immediately, and there is no
unblock action to perform.

```sh
bb tasks-plus blocker add ABC-12 ABC-9   # ABC-12 is blocked by ABC-9
bb tasks-plus blocker rm ABC-12 ABC-9
bb tasks-plus blocker list ABC-12        # both directions: blocked by, and blocking
```

Blocking is enforced, not advisory: a blocked task refuses
`--status in_progress` and refuses `dispatch`. Cycles are rejected when the edge
is written. Resolved blockers stay in the list — the list is the record of what
held the task up.

Blockers are orthogonal to `--parent`. A parent groups work; a blocker orders
it. A task may be blocked by a task in another project.

## Use as the project issue tracker

Skills that speak of "the issue tracker", "publishing an issue", "fetching a
ticket", or triage labels mean Tasks Plus — unless the repo carries its own
`docs/agents/issue-tracker.md`, which wins where it exists. An issue number is a
task key such as `ABC-12`.

Two things a skill writes as prose are relations here, and the relation is the
record:

- a **Parent** section → `--parent <key>` on create
- a **Blocked by** section → `bb tasks-plus blocker add <task> <blocker>`

So create parents before children and blockers before dependents, and capture
each new key with `--json | jq -r '.task.key'`.

The five triage roles — `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix` — are labels. Statuses track the work itself and
drive blocker resolution, so they stay free of triage state. Create a missing
label with `bb tasks-plus label create --project <prefix> --name <name>`.

## Link tasks in responses

When your answer refers the user to a task — including a task you just
created — emit this leaf directive on its own line instead of writing the
key as plain text:

```md
::task{key="ABC-12"}
```

`key` is required. Optionally add `title="…"` as a display fallback shown
while the card loads and when the key no longer resolves. The rendered card
shows the live status, title, and priority, opens the task in the thread
side panel, and links to the full Tasks app. Emit one directive per line;
each renders its own card.

## Invariants

- Valid task statuses are `backlog`, `todo`, `in_progress`, `in_review`,
  `done`, and `canceled`.
- Use `in_review` when implementation is complete but still needs human or
  agent review. Use `done` only when the task's completion criteria are met.
- Write one comment per meaningful milestone. Combine related facts into a
  useful update; never spam progress pings, command-by-command narration, or
  repeated status messages.
- Comments should say what changed or was learned, what validation ran, and any
  remaining risk or blocker.
- Prefer stable task keys such as `ABC-12` for task commands. Use `--json` for
  machine-readable output and human output for quick inspection.
