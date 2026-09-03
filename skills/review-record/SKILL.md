---
name: review-record
description: "Two-axis review of changes since a fixed point, using one Sol reviewer for a small task or independent Sol reviewers for a complex task, with targeted verification after fixes."
---

Two-axis review of the diff between `HEAD` and a fixed point for the task that
asked for the work:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement the originating task?

The task is the spec. Tasks Plus is the tracker: `bb tasks-plus`, commands in the
`tasks-plus` skill. The coordinator is the sole task writer.

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
here rather than inside a reviewer thread.

### 2. Resolve the task — the spec and the destination

The key comes from the invocation, the branch name, or
`git log <fixed-point>..HEAD` — in that order. If none of the three yields one,
ask.

```sh
bb tasks-plus show <KEY> --json
bb tasks-plus artifact list <KEY> --kind approved_plan --json
bb tasks-plus artifact show <artifact-id>
```

The description is the spec. The direction is the newest `approved_plan`
artifact, and for a slice it lives on the **parent**: read `parentTaskId` from
`show --json` and list the parent's artifacts too. The Spec axis judges the
diff against both.

Stop here if the key fails to resolve or names a task unrelated to the commits —
no task means no record, so there is nothing to review into.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as
`CODING_STANDARDS.md` or `CONTRIBUTING.md`. Sweep the repo root, `docs/`,
`.github/`, and the directories the diff touches; the step is done when every
candidate found is either listed in the Standards prompt or set aside for a
stated reason.

On top of whatever the repo documents, the Standards axis always carries the
**smell baseline** below: a fixed set of Fowler code smells (_Refactoring_,
ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it
  endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible
  Feature Envy"), never a hard violation. Like any standard here, skip anything
  tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

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

### 4. Choose the review shape

A **small** change is one cohesive behaviour in one layer or module with no
public API, cross-package contract, schema or migration, auth/security,
concurrency/lifecycle, architectural change, significant interaction or
accessibility behaviour, material deviation, or several independent concerns.
Everything else is **complex**.

- Small: one fresh BB child thread reviews both axes and returns separate
  `## Standards` and `## Spec` sections.
- Complex: two fresh BB child threads run concurrently, one per axis.

Every axis runs as the **reviewer** role: a small review and the Standards
axis at its default level, the Spec axis of a complex review at its high
level. The role and its levels are named in
the custom instructions, which also fix what a reviewer thread may and may not
do. Use the **bb-cli** skill for spawn mechanics.

A provider limit pauses an axis rather than changing its reviewer. Check
`bb provider-retry status <thread-id>`; when a retry is scheduled, wait for that
thread to finish and collect its eventual report. Mark the axis `Not run` only
when no retry remains or the user chooses to proceed without it. A fallback to
another provider is a user decision.

These rules belong **inside every reviewer prompt**:

- **This thread owns its findings.** Say that the coordinator will report fixes
  back to this same thread, and that it will then re-check its own findings
  and judge each written disposition.
- **Paste the smell baseline into the Standards prompt in full.** It exists
  nowhere in the repo, so a fresh agent has no other way to reach it. Everything
  else an axis needs is a path the agent can read for itself.
- **Same briefs, same word limit.** A combined reviewer receives both briefs and
  returns separate sections. Independent reviewers receive one brief each.

**Standards prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell
  baseline from step 3** pasted in full (the agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec prompt** should include:

- The diff command and commit list.
- The task description and every plan source from step 2, pasted in.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

### 5. Aggregate

Keep the two reports under `## Standards` and `## Spec`, each complete and
verbatim, findings unmerged and unreranked. Every axis gets a section, and its
body is exactly one of: the findings; the line `No findings.`; or
`Not run: <reason>` (agent failed, axis skipped). An unrun axis says so in those
words.

End with `## Summary`: total findings per axis, and the worst issue _within each
axis_. Report each axis on its own terms rather than picking one winner across
them.

### 6. Keep or record the result

Keep a clean report in the coordinator thread for narrative review. Persist a
`review_result` only when findings remain unresolved, an audit requires a
durable result, or the user requested one. When persisted, write the aggregate
under `$BB_THREAD_STORAGE` with repo, origin, task, refs, commits, reviewer model
and timestamp.

### 7. Verdict and counts for a durable result

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

### 8. Write a durable result when required

```sh
bb tasks-plus artifact add <KEY> --kind review_result \
  --title "Code review: <fixed-point>..<short-head>" \
  --body-file <body> --meta-file <meta> --json
```

Report the review as recorded once the command returns `.artifact.id`. On
failure, report the failure and the path of the retained body file.

Do not add a review-progress or disposition comment. The final hand-back points
to a durable result when one exists.

### 9. Close the findings

Run the **review loop** from the custom instructions: fix or delegate, then
`bb thread tell` the reviewer that raised each finding with the corrected sha,
what changed per finding, and each unfixed finding with its reason. It answers
with `closed`, `open`, or `regressed` per finding and a judgement on each
disposition. Repeat in that thread until nothing is `open` without a reason.

Repeat the full small/complex review only when a fix materially changes
behaviour, architecture, security, data, or a public contract.

## Why two axes

A change can pass one axis and fail the other: code that follows every standard
while implementing the wrong thing, or code that does exactly what the task
asked while breaking the project's conventions. Reporting them separately stops
one axis from masking the other.

## Out of scope

The narrative `review` artifact, which groups the diff by concern, is a different
record with a different shape.
