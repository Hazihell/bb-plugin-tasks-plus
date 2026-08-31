---
name: review-record
description: "Review the changes since a fixed point along two axes — Standards and Spec — against the originating Tasks Plus task, and persist the aggregate as a `review_result` artifact on that task, with one comment as the index. Use when a review must outlive the thread it ran in, or when asked to review and record."
disable-model-invocation: true
---

Two-axis review of the diff between `HEAD` and a fixed point, recorded on the
task that asked for the work:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating task?

The task is both the spec and the destination. One lookup fixes what the review
is judged against and where the result lands, so a review can never be recorded
against a task other than the one that briefed it.

The axes run as **parallel agents** so they don't pollute each other's context.
They are never told the task key and never write anything: there is one writer,
one failure point, and nothing to clean up when an axis dies.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill. A
`review_result` is a Tasks Plus record, so a repo on another tracker puts this
skill out of scope rather than redirecting it.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag,
`main`, `HEAD~5`). If they didn't specify one, ask for it.

Capture identity in one go, so the record describes the tree that was reviewed
rather than whatever `HEAD` drifts to:

```sh
git rev-parse --show-toplevel
git remote get-url origin
git rev-parse <fixed-point>
git rev-parse HEAD
git log <fixed-point>..HEAD --oneline
```

The diff command for the rest of this skill is `git diff <fixed-point>...HEAD`
— three-dot, so the comparison is against the merge-base. Confirm here that the
fixed point resolves and the diff is non-empty; a bad ref or empty diff fails
here rather than inside two parallel agents.

### 2. Resolve the task — the spec and the destination

The key comes from the invocation, the branch name, or
`git log <fixed-point>..HEAD` — in that order. If none of the three yields one,
ask.

```sh
bb tasks-plus show <KEY> --json
bb tasks-plus artifact list <KEY> --kind approved_plan --kind implementation_plan --json
bb tasks-plus artifact show <artifact-id>
```

The description is the spec; the plan artifacts are what the builder was told to
follow. Collect the design too: `to-spec-and-design` publishes it as an
`approved-plan.md` **attachment** rather than an artifact, so fetch any
attachment whose name says plan or design, from the `attachments` in
`show --json`:

```sh
bb tasks-plus attachment get <attachment-id> --out <path>
```

Stop here if the key fails to resolve or names a task unrelated to the commits —
no task means no record, so there is nothing to review into.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as
`CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the
**smell baseline** below: a fixed set of Fowler code smells (_Refactoring_,
ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it
  endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible
  Feature Envy"), never a hard violation. Like any standard here, skip anything
  tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Dispatch both axes in parallel

**Pick the reviewer first.** Default: one message with two `Agent` tool calls,
`general-purpose` for both.

When the user asks for codex (`codex`, "with codex", "second model"), keep the
structure identical and swap only who runs each axis. Follow the **codex** skill
for the spawn mechanics; the shape here is two bb threads, spawned in one
message so they run concurrently:

- `--provider codex --model gpt-5.6-sol --reasoning-level high --parent-self`
- Titles `review/standards: <fixed-point>..HEAD` and `review/spec: <fixed-point>..HEAD`
- One axis per agent. Never one agent carrying both axes: that is the context
  pollution the split exists to prevent.

Four rules belong **inside each prompt**, on both routes:

- **The agent does the review itself.** It reads the diff and writes the report
  with its own eyes, spawning nothing and delegating no further. State this
  explicitly; without it the agent re-delegates and you get a summary of a
  summary.
- **Read-only.** It reports findings and changes no files, writes no scratch
  notes, and runs no command that mutates the repo. `git diff`, `git log`, and
  reading files are the whole toolkit.
- **Paste the smell baseline into the Standards prompt in full.** It exists
  nowhere in the repo, so a fresh agent has no other way to reach it. Everything
  else an axis needs is a path the agent can read for itself.
- **Same brief, same word limit.** Use the axis briefs below verbatim. A codex
  report and a Claude report should be interchangeable in the aggregate.

Name the reviewer in the final record, so a codex review is never mistaken for a
Claude one.

**Standards prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell
  baseline from step 3** pasted in full (the agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec prompt** should include:

- The diff command and commit list.
- The task description and the plan artifacts from step 2, pasted in.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

### 5. Aggregate

Keep the two reports under `## Standards` and `## Spec`, each complete and
verbatim. Leave findings unmerged and unreranked, because the two axes are
deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue
_within each axis_. Report each axis on its own terms rather than picking one
winner across them: that cross-axis ranking is what the separation exists to
prevent.

### 6. Assemble the record

A markdown body, written to a file under `$BB_THREAD_STORAGE`:

- A header block: repo path and `origin` URL, task key, fixed point as given and
  its resolved SHA, `HEAD` SHA, the commit list, the reviewer model, and the
  timestamp.
- `## Standards` and `## Spec` — each axis's section from step 5.
- `## Summary` — the per-axis summary line.

Every axis gets a section, and its body is exactly one of: the findings; the line
`No findings.`; or `Not run: <reason>` (agent failed, axis skipped). An unrun
axis says so in those words.

### 7. Verdict and counts

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

### 8. Write the artifact

```sh
bb tasks-plus artifact add <KEY> --kind review_result \
  --title "Code review: <fixed-point>..<short-head>" \
  --body-file <body> --meta-file <meta> --json
```

Report the review as recorded once the command returns `.artifact.id`. On
failure, report the failure and the path of the retained body file.

### 9. Comment as the index

One milestone comment: verdict, per-axis counts, `<fixed-point>..HEAD`, and the
artifact id. It points at the artifact and leaves the findings in it.

## Why two axes

A change can pass one axis and fail the other: code that follows every standard
while implementing the wrong thing, or code that does exactly what the task
asked while breaking the project's conventions. Reporting them separately stops
one axis from masking the other.

## Out of scope

The narrative `review` artifact, which groups the diff by concern, is a different
record with a different shape.
