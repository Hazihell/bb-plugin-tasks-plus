---
name: review-record
description: "Run the two-axis /code-review and persist its result as a durable review_result artifact on the originating task, with one milestone comment pointing at it. Use when a review's outcome must survive the conversation — reviewing a branch or PR against a task, or when asked to 'review and record'."
disable-model-invocation: true
---

This skill wraps `/code-review`; it does not replace or amend it. `/code-review`
keeps its two axes, its prompts and its aggregation. This skill pins what was
reviewed, invokes it verbatim, and turns the aggregate into a `review_result`
artifact plus one comment.

Nothing flows the other way. The reviewer sub-agents are never told a task key,
never write files, and never know they are being recorded. One writer, one
failure point, and no cleanup to do when an axis dies.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill.
A repo's `docs/agents/issue-tracker.md` overrides it.

## Process

### 1. Resolve the task key

In order: the key given in the invocation; a task key in the branch name; a task
key in `git log <fixed-point>..HEAD`. If none is found, ask. Never guess, and
never write to a task the review did not come from.

### 2. Pin identity before reviewing

Capture all of this first, so the record describes the tree that was reviewed
rather than whatever `HEAD` becomes afterwards:

```sh
git rev-parse --show-toplevel
git remote get-url origin
git rev-parse <fixed-point>
git rev-parse HEAD
git log <fixed-point>..HEAD --oneline
```

### 3. Invoke `/code-review`

Pass the fixed point through, and the `codex` argument too if the user gave one.
Do not re-plan, re-scope or re-run the review, and do not read the diff yourself.
If `/code-review` is unavailable, stop and say so — never improvise a review in
its place.

### 4. Assemble the record

Write a markdown body to a file under `$BB_THREAD_STORAGE`:

- A header block: repo path and `origin` URL, task key, fixed point as given
  and its resolved SHA, `HEAD` SHA, the commit list, the reviewer model (Claude
  sub-agents or `gpt-5.6-sol` via bb threads — name it exactly as
  `/code-review` reported it), and the timestamp.
- `## Standards` — that axis's section, complete and verbatim.
- `## Spec` — that axis's section, complete and verbatim.
- `## Summary` — the per-axis summary line `/code-review` ended with.

Every axis gets a section, always. Its body is one of: the findings; the exact
line `No findings.`; or `Not run: <reason>` (no spec found, thread failed, axis
skipped). Never omit an axis section, and never write "not run" as "no findings".

### 5. Verdict and counts

Write a metadata file carrying exactly `verdict` and `findingCounts` — the schema
is strict and rejects any other field.

`findingCounts` has one key per axis that **ran**, such as
`{"standards": 3, "spec": 0}`. An axis that did not run is **absent** from the
map: `0` means ran-and-clean, absence means not-run. The machine-readable side
follows the same rule as the prose.

`verdict` is `pass` only when every axis ran and every count is `0`; `fail` when
every axis that ran reported findings; `mixed` otherwise, including whenever an
axis did not run. An incomplete review can never read as `pass`.

### 6. Write the artifact

```sh
bb tasks-plus artifact add <KEY> --kind review_result \
  --title "Code review: <fixed-point>..<short-head>" \
  --body-file <body> --meta-file <meta> --json
```

Capture `.artifact.id`. If the command fails, report the failure and the path of
the retained body file. Never report the review as recorded when it is not.

### 7. Comment as the index

Post one milestone comment: verdict, per-axis counts, `<fixed-point>..HEAD`, and
the artifact id. It points at the artifact; it does not restate the findings.

## Out of scope

The narrative `review` artifact and its grouped concerns are a different record
with a different shape. This skill writes `review_result` only.
