---
name: to-spec-and-design
description: "Turn a conversation into a spec, a direction and a graph of tracer-bullet slices on the issue tracker; then close the parent out when its slices are done. Use when a discussed feature is ready to write up, when a plan needs breaking into tickets with blocking edges, or when a finished task graph needs its integration check."
disable-model-invocation: true
---

Synthesize what you already know from the conversation and the codebase. The user has finished discussing; write it down rather than interviewing them. The seams in step 2 are the one question asked before the gate.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill. A repo's `docs/agents/issue-tracker.md` overrides it.

## Process

1. Explore the repo if you haven't. Use the project's domain glossary throughout, and respect the ADRs covering the area you're touching.

2. Sketch the seams you'll test the feature at. Prefer existing seams, and propose any new one at the highest point you can. The fewer across the codebase the better; one is ideal. Check the seams with the user before going further.

3. Write the direction from the `<direction-template>` below, only when the work is more than one slice. It is the one document every slice and the close-out share: it says what must stay true across agents who never share a context. Describe parts by the role they play; classes, functions and files belong to each slice's local plan.

4. Break the work into slices. Draft them as **tracer bullets**:

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice fits a single fresh context window
- Prefactoring goes first

</vertical-slice-rules>

Give each slice its **blocking edges**: the slices that must complete before it can start. No blockers means it can start now. A feature that is genuinely one slice stays one slice.

**A wide refactor is the exception.** When one mechanical change (rename a column, retype a shared symbol) has a **blast radius** across the whole codebase, no vertical slice can land green. Sequence it **expand–migrate–contract**: expand adds the new form beside the old; each migrate batch is its own slice blocked by the expand, sized by blast radius, and stays green because the old form survives; contract deletes the old form, blocked by every batch. Where even the batches can't stay green alone, let them share an integration branch that blocks a final integrate-and-verify slice, and promise green only there.

5. Put the spec, the direction and the breakdown to the user at **one gate**. The breakdown is a numbered list giving each slice its **title**, what it **delivers** end to end, and what **blocks** it.

Ask whether the granularity is right, whether each edge genuinely gates its slice, and whether any slices should merge or split. Ask two dispatch facts too, always, with the default named so the user confirms rather than assumes:

- the **base branch** the graph builds on: the repository default, or a campaign or integration branch. A dispatch spawns its worktree from the resolved branch, and an unset one silently means the default.
- the **delivery**: `pull request` or `branch only`. Branch only means the working thread commits, pushes if the repository pushes, and hands back naming the branch; the human merges.

Publish only once the user approves everything together, revising and asking again after each change.

6. Publish. The spec is the task description. Its `## Goal` section is what every slice receives eagerly in its dispatch packet, so it carries the delivery line. The direction is an `approved_plan` artifact on the same task, separately addressable, so a slice packet and the close-out fetch the direction alone.

One slice means no umbrella and no direction. Publish a single task and stop here:

```sh
KEY=$(bb tasks-plus create --title "$TITLE" --description-file "$SPEC" \
  --label ready-for-agent ${BASE_BRANCH:+--base-branch "$BASE_BRANCH"} --json | jq -r '.task.key')
```

Otherwise the parent comes first, unlabelled: `ready-for-agent` says an agent may pick the work up, and an umbrella is not a unit of work.

```sh
KEY=$(bb tasks-plus create --title "$TITLE" --description-file "$SPEC" \
  ${BASE_BRANCH:+--base-branch "$BASE_BRANCH"} --json | jq -r '.task.key')
printf '{"approvedBy":"%s","approvedAt":"%s"}\n' "$USER_NAME" "$(date +%F)" > "$META"
bb tasks-plus artifact add "$KEY" --kind approved_plan --title "Direction" \
  --body-file "$DIRECTION" --meta-file "$META"
```

Set the base branch on the parent only. Slices inherit it, so a slice names one solely to override its parent.

Then one child per slice, in dependency order, **unlabelled**, from the `<slice-template>` below. Record each blocking edge as soon as both ends exist; a slice's blockers always precede it in dependency order, so its edges can be written right after it:

```sh
SLICE_1=$(bb tasks-plus create --title "$SLICE_1_TITLE" --description-file "$SLICE_1_BODY" \
  --parent "$KEY" --json | jq -r '.task.key')
SLICE_2=$(bb tasks-plus create --title "$SLICE_2_TITLE" --description-file "$SLICE_2_BODY" \
  --parent "$KEY" --json | jq -r '.task.key')
bb tasks-plus blocker add "$SLICE_2" "$SLICE_1"   # slice 2 is blocked by slice 1
```

Label last, once every edge is in place, so nothing is dispatchable before its blockers are recorded:

```sh
for SLICE in "$SLICE_1" "$SLICE_2"; do
  bb tasks-plus update "$SLICE" --label ready-for-agent
done
```

No further triage is needed.

## Close out the parent

When the last slice is done, the parent is checked against its direction before it is closed. Run this on the parent, with the base branch checked out at the state that contains every slice:

1. Fetch the direction: `bb tasks-plus artifact list "$KEY" --kind approved_plan --json`, newest first, then `artifact show`.
2. Spawn the **reviewer** role at its high level with the integrated diff (base of the parent to the integrated head), the direction and the spec's Goal. Its brief: for each boundary and invariant, say whether the built system honours it, where it gave way, and any behaviour no slice was asked for. Under 400 words.
3. Record the answer as a `review_result` on the parent when anything gave way; a clean answer is one comment on the parent saying so. The human sets `done`.

## Writing the documents

Keep file paths and code snippets out of all of them: they go stale fast. The exception is a snippet a prototype produced that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape) — inline the decision-rich parts within the decision itself, note it came from a prototype, and leave the working demo out.

Parent and blocked-by are relations on this tracker, so record them as relations rather than writing them as sections.

<spec-template>

## Goal

One paragraph: the problem and the solution, from the user's perspective. This paragraph rides in every slice's dispatch packet. End it with the dispatch facts on their own lines:

Delivery: pull request | branch only

## User Stories

An extremely extensive numbered list covering every aspect of the feature, each in the form:

1. As an <actor>, I want a <feature>, so that <benefit>

## Implementation Decisions

The behaviour that was settled: technical clarifications from the developer, schema changes, specific interactions. Boundaries, what crosses them and what must stay true belong to the direction, which owns them.

## Testing Decisions

What makes a good test here (external behaviour, not implementation details), which parts will be tested, and the prior art in the codebase for those tests.

## Out of Scope

What this spec does not cover.

## Further Notes

Anything else worth recording.

</spec-template>

<direction-template>

## Boundaries

Which parts own what, what crosses each seam and in which direction, and why this cut rather than the nearest alternative.

## Invariants

What must be true after every slice lands, stated so a reviewer can check it. What this design refuses to do.

## Failure and compatibility

Where errors are caught and what state remains. What existing callers and data must keep working while slices land.

</direction-template>

<slice-template>

## What to build

The end-to-end behaviour this slice makes work, from the user's perspective, not a layer-by-layer implementation list.

## Serves

The boundary or invariant in the direction this slice realises, in one line.

## Seam

Where this slice is tested, from the seams agreed at the gate.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

</slice-template>
