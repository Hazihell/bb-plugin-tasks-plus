---
name: review-record
description: "Run /code-review and persist its aggregate as a `review_result` artifact on the originating task, with one comment as the index. Use when a review must outlive the thread it ran in, or when asked to review and record."
disable-model-invocation: true
---

A wrapper around `/code-review`, which keeps its two axes, its prompts and its
aggregation untouched. This skill pins what was reviewed, invokes the review
verbatim, and turns what comes back into a durable record.

The seam is one-way. The reviewer sub-agents are never told a task key and never
write anything, so there is one writer, one failure point, and nothing to clean
up when an axis dies.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill. A
`review_result` is a Tasks Plus record, so a repo on another tracker puts this
skill out of scope rather than redirecting it.

## Process

### 1. Resolve the task, and read it

The key comes from the invocation, the branch name, or
`git log <fixed-point>..HEAD` — in that order. If none of the three yields one,
ask.

Then read the task before writing to it:

```sh
bb tasks-plus show <KEY> --json
```

Stop here if the key fails to resolve or names a task unrelated to the commits.

### 2. Pin identity before reviewing

Capture all of this first, so the record describes the tree that was reviewed
rather than whatever `HEAD` drifts to:

```sh
git rev-parse --show-toplevel
git remote get-url origin
git rev-parse <fixed-point>
git rev-parse HEAD
git log <fixed-point>..HEAD --oneline
```

### 3. Invoke `/code-review`

Pass through the fixed point, and the `codex` argument if the user gave one.
`/code-review` owns the review itself: your part is the fixed point in and the
aggregate out. If it is unavailable, stop and say so.

### 4. Assemble the record

A markdown body, written to a file under `$BB_THREAD_STORAGE`:

- A header block: repo path and `origin` URL, task key, fixed point as given and
  its resolved SHA, `HEAD` SHA, the commit list, the reviewer model named exactly
  as `/code-review` reported it, and the timestamp.
- `## Standards` and `## Spec` — each axis's section, complete and verbatim.
- `## Summary` — the per-axis summary line `/code-review` ended with.

Every axis gets a section, and its body is exactly one of: the findings; the line
`No findings.`; or `Not run: <reason>` (no spec found, thread failed, axis
skipped). An unrun axis says so in those words.

### 5. Verdict and counts

A metadata file carrying `verdict` and `findingCounts`, and nothing else — the
schema is strict.

`findingCounts` holds one key per axis that **ran**, such as
`{"standards": 3, "spec": 0}`. `0` means ran-and-clean; an axis that did not run
is **absent** from the map.

`verdict` takes the first rule that matches, so one review always yields one
verdict:

1. An axis missing from `findingCounts` — `mixed`. An incomplete review never
   reads as `pass`.
2. Every count `0` — `pass`.
3. Every count above `0` — `fail`.
4. Otherwise — `mixed`.

### 6. Write the artifact

```sh
bb tasks-plus artifact add <KEY> --kind review_result \
  --title "Code review: <fixed-point>..<short-head>" \
  --body-file <body> --meta-file <meta> --json
```

Report the review as recorded once the command returns `.artifact.id`. On
failure, report the failure and the path of the retained body file.

### 7. Comment as the index

One milestone comment: verdict, per-axis counts, `<fixed-point>..HEAD`, and the
artifact id. It points at the artifact and leaves the findings in it.

## Out of scope

The narrative `review` artifact, which groups the diff by concern, is a different
record with a different shape.
