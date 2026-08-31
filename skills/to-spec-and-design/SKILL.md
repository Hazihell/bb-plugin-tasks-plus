---
name: to-spec-and-design
description: "Turn a conversation into a spec, a system design and a breakdown into tracer-bullet subtasks, published to the issue tracker as a task graph. Use when a discussed feature is ready to write up, when its technical direction needs agreeing at the same gate, or when a plan needs breaking into tickets with blocking edges."
disable-model-invocation: true
---

Synthesize what you already know from the conversation and the codebase. The user has finished discussing; write it down rather than interviewing them.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill. A repo's `docs/agents/issue-tracker.md` overrides it.

## Process

1. Explore the repo if you haven't. Use the project's domain glossary throughout, and respect the ADRs covering the area you're touching.

2. Sketch the seams you'll test the feature at. Prefer existing seams, and propose any new one at the highest point you can. The fewer across the codebase the better; one is ideal.

Check the seams with the user before going further.

3. Design the system using the `<design-template>` below. Describe each part by the role it plays, and leave the classes, functions and files to the local plan each subtask writes when its work begins.

4. Break the work into subtasks. The design's **Deliberately Undecided** section names what each subtask must settle; this step decides where the cuts fall.

Draft the work as **tracer bullets**:

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice fits a single fresh context window
- Prefactoring goes first

</vertical-slice-rules>

Give each slice its **blocking edges**: the slices that must complete before it can start. No blockers means it can start now. A feature that is genuinely one slice stays one slice.

**A wide refactor is the exception.** When one mechanical change (rename a column, retype a shared symbol) has a **blast radius** across the whole codebase, no vertical slice can land green. Sequence it **expand–migrate–contract**: expand adds the new form beside the old; each migrate batch is its own subtask blocked by the expand, sized by blast radius, and stays green because the old form survives; contract deletes the old form, blocked by every batch. Where even the batches can't stay green alone, let them share an integration branch that blocks a final integrate-and-verify subtask, and promise green only there.

5. Write the spec, the design and the breakdown, and put all three to the user at **one gate**. The breakdown is a numbered list giving each slice its **title**, what it **delivers** end to end, and what **blocks** it.

Ask whether the granularity is right, whether each edge genuinely gates its slice, and whether any slices should merge or split. Ask too which **base branch** the work builds on when it is not the repository default — a campaign branch, a long-lived integration branch — because a dispatch spawns its worktree from the resolved branch, and an unset one silently means the default. Publish only once the user approves the three together, revising and asking again after each change.

6. Publish. The spec is the task description; the design attaches to the same task, separately addressable, so a later integration review can fetch the direction alone and diff the built architecture against it.

One slice means no umbrella. Publish a single task and stop here:

```sh
KEY=$(bb tasks-plus create --title "$TITLE" --description-file "$SPEC" \
  --label ready-for-agent ${BASE_BRANCH:+--base-branch "$BASE_BRANCH"} --json | jq -r '.task.key')
bb tasks-plus attachment add "$KEY" --file "$DESIGN" --name approved-plan.md
```

Otherwise the parent comes first, unlabelled: `ready-for-agent` says an agent may pick the work up, and an umbrella is not a unit of work.

```sh
KEY=$(bb tasks-plus create --title "$TITLE" --description-file "$SPEC" \
  ${BASE_BRANCH:+--base-branch "$BASE_BRANCH"} --json | jq -r '.task.key')
bb tasks-plus attachment add "$KEY" --file "$DESIGN" --name approved-plan.md
```

Set the base branch on the parent only. Slices inherit it, so a slice names one solely to override its parent.

Then one child per slice, in dependency order, from the `<slice-template>` below. Capture every key, because the edges are recorded by key:

```sh
SLICE_1=$(bb tasks-plus create --title "$SLICE_1_TITLE" --description-file "$SLICE_1_BODY" \
  --label ready-for-agent --parent "$KEY" --json | jq -r '.task.key')
SLICE_2=$(bb tasks-plus create --title "$SLICE_2_TITLE" --description-file "$SLICE_2_BODY" \
  --label ready-for-agent --parent "$KEY" --json | jq -r '.task.key')
```

Finally each blocking edge, once both of its ends exist:

```sh
bb tasks-plus blocker add "$SLICE_2" "$SLICE_1"   # slice 2 is blocked by slice 1
```

No further triage is needed.

## Writing the three documents

Keep file paths and code snippets out of all three: they go stale fast. The exception is a snippet a prototype produced that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape) — inline the decision-rich parts within the decision itself, note it came from a prototype, and leave the working demo out.

Parent and blocked-by are relations on this tracker, so record them as relations rather than writing them as sections.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

An extremely extensive numbered list covering every aspect of the feature, each in the form:

1. As an <actor>, I want a <feature>, so that <benefit>

## Implementation Decisions

The behaviour that was settled: modules built or modified, technical clarifications from the developer, schema changes, specific interactions. Boundaries, interfaces, API contracts and architectural decisions belong to the design, which owns them.

## Testing Decisions

What makes a good test here (external behaviour, not implementation details), which modules will be tested, and the prior art in the codebase for those tests.

## Out of Scope

What this spec does not cover.

## Further Notes

Anything else worth recording.

</spec-template>

<design-template>

## Boundaries

Which parts own what, where the new seam falls, and what each side is allowed to know about the other.

## Data Flows and Interfaces

What crosses each boundary and in which direction: the information carried, who produces it and who consumes it. Shape and meaning, not signatures.

## Constraints

The compatibility, performance, security and platform limits this direction honours. Mark the ones the design actually binds, where a choice exists only to satisfy them.

## Architectural Invariants

What must still be true after the change, stated so a later reader can check it, and what this design refuses to do.

## Evidence Strategy

How anyone tells that the built thing matches this direction: the seams agreed with the user, what each demonstrates, and what the integration review diffs against.

## Deliberately Undecided

The decisions this design leaves to the subtasks, including every choice of class, function and file, so each subtask writes its own local plan when its work begins.

</design-template>

<slice-template>

## What to build

The end-to-end behaviour this slice makes work, from the user's perspective, not a layer-by-layer implementation list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

</slice-template>
