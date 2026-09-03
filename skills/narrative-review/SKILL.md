---
name: narrative-review
description: "Write a finished code change up for a human as a grouped narrative review on the issue tracker. Use after a code review completes and the change needs explaining, or when asked for a narrative or grouped review of a branch."
---

# Narrative review

A diff is ordered by file because that is how git stores it, not because that is
how a reader understands it. This skill turns a change that has already been
reviewed into a `review` artifact on its task: a handful of concerns, each one a
behaviour a human has to form a judgement about, with the prose that says why it
exists and the few line ranges worth actually reading.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill.

## 1. Pin the commit

Do this before reading a single line of the diff.

```sh
HEAD_SHA=$(git rev-parse HEAD)
BASE=$(git merge-base <base-ref> "$HEAD_SHA")
git diff "$BASE" "$HEAD_SHA"
```

Read that diff and no other. A worktree is live: `git diff <base-ref>` sweeps
in uncommitted edits and `HEAD` moves, so a review taken from either describes a
tree that no longer exists while claiming a sha that does — worse than no
review, because it looks trustworthy. Every later step — the grouping, the line
ranges, the verification — works from this one pair of shas.

Record `$HEAD_SHA` as `headSha` and the base ref you named as `baseRef`. Uncommitted
work is outside the review; commit it or leave it out and say so.

`environmentId` is `$BB_ENVIRONMENT_ID`, or `null` when you are outside an
environment.

### A review answering an earlier one

When the task already carries a review that a human answered, the new review is
a round, and a round covers only what the reader has not read. Use the answered
review's `headSha` as `<base-ref>`: everything before it has already been
judged, and describing it again asks the reader to re-approve work they approved
last round.

```sh
BASE=$(bb tasks-plus artifact show <previous-review-id> --json \
  | jq -r .metadata.headSha)
```

Group and write exactly as any other review — the concerns are the new
behaviours, not a list of fixes against the feedback. Say in one opening line
which review this answers, and leave the earlier change to the earlier review.

## 2. Read the task back

```sh
bb tasks-plus show <key> --json
bb tasks-plus artifact list <key> --json
```

Read only the records that shaped the final change. A task-local plan, decision
or check result may live only in the coordinator's hand-off; a separate artifact
exists only when another task, approval or audit needs to trust it independently.

## 3. Group by behaviour

Each concern is one thing a reader must form a judgement about.
"Introduce permission evaluation" is a concern. "Changes to `perm.ts`" is not —
it names a location, and leaves the reader to work out what happened there.

A concern may span several files. A file may appear in several concerns. A file
may appear in none, when nothing about it needs a human's judgement.

Read your concern titles back before you write anything. If they are file names,
the grouping has failed and must be redone from the behaviour up; that failure
is the whole reason this skill exists. An ordinary change lands at roughly three
to seven concerns. Below that you are summarising, above it you are writing a
changelog.

## 4. Fill each concern

`why` is the engineering reason, taken from the plan and the decisions — what
problem this solves and what it cost. A restatement of the diff in prose is not
a `why`.

`risks` is what a reader should watch after this merges. Leave it empty when
there is nothing; an empty string is honest and a manufactured risk is not.

`evidence` and `decisions` cite independently durable artifacts when they exist.
Empty arrays are normal. Check every id against the list from step 2 and drop any
you cannot resolve.

`validation` records the final commands a human needs to assess: command,
`passed` / `failed` / `not_run`, and a short summary. It replaces routine
per-command evidence artifacts.

`hunks` are the ranges a reader should actually read, not the full extent of the
change. Verify each one against the pinned sha:

```sh
git show "$HEAD_SHA:<path>" | sed -n '<startLine>,<endLine>p'
```

so that `endLine` exists in the file at that sha. A concern with no hunks is
legal — use it for something the diff cannot show, such as a behaviour that
emerges from a deletion or a convention the change establishes.

## 5. Write the body, then the artifact

The body is the narrative a human reads with no renderer at all: one section per
concern, in the order the concerns are listed, saying what changed, why, and
what it costs. Write it as plain markdown that stands on its own.

Write the metadata and the body to files — never shell-quote them — and post
once:

```sh
bb tasks-plus artifact add <key> --kind review \
  --title "<the change, in a phrase>" \
  --body-file <path> --meta-file <path>
```

Artifacts are append-only. A review that turned out wrong is superseded by a
later one that says so, not edited.

## What this skill does not do

It does not find defects. `/review-record` owns that. A clean result normally
flows straight into this narrative; a separate `review_result` is reserved for
unresolved findings, audit requirements, or an explicit request.

## Worked example

Metadata for a two-concern review, as passed to `--meta-file`:

```json
{
  "baseRef": "main",
  "headSha": "4f1c9ab7d2e5f60318b4c7a9d0e2f3b1a6c8d9e0",
  "environmentId": "env_zb94adftdg",
  "validation": [
    { "command": "pnpm test", "result": "passed", "summary": "42 tests" }
  ],
  "concerns": [
    {
      "title": "Evaluate permissions at the request boundary",
      "why": "Every handler was re-deriving the caller's rights from the session row, so a new handler could forget to. The decision artifact settled on one evaluation point ahead of dispatch, which makes the omission impossible rather than merely discouraged.",
      "evidence": ["01JQ8Z4B2C3D4E5F6G7H8J9KMN"],
      "decisions": ["01JQ8Z3K7M4N5P6R7S8T9VWXYZ"],
      "risks": "The evaluator runs before routing, so an unauthenticated health check now pays a lookup it does not need.",
      "hunks": [
        { "path": "server.ts", "startLine": 88, "endLine": 121 },
        { "path": "shared/permissions.ts", "startLine": 1, "endLine": 46 },
        { "path": "api/handlers.ts", "startLine": 203, "endLine": 214 }
      ]
    },
    {
      "title": "Session rights are no longer a public surface",
      "why": "The old helper that read rights off a session is gone, and nothing replaces it. Callers outside this repo that reached for it will not compile, which is intended: there is no supported way to ask that question outside the boundary.",
      "evidence": [],
      "decisions": ["01JQ8Z5R9S2T4V6W8X0Y2Z4A6B"],
      "risks": "",
      "hunks": []
    }
  ]
}
```

The matching body opens each section with the concern title, in the same order:

```md
## Evaluate permissions at the request boundary

Permission checks used to sit in each handler, which meant a new handler was one
forgotten line away from being open. The change moves the decision ahead of
dispatch: the router asks once, and a handler receives a caller that has already
been judged. Handlers get shorter and lose a way to be wrong; the cost is a
lookup on requests that do not need one.

## Session rights are no longer a public surface

Removing the session-rights helper is the point, not a side effect. …
```
