---
name: to-spec-and-design
description: "Turn the current conversation into a spec, a system design and a breakdown into tracer-bullet subtasks, and publish them to the issue tracker. Use when a discussed feature is ready to write up, when a spec needs its technical direction agreed at the same gate, or when a plan needs breaking into tickets with blocking edges."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces two documents and a task graph: a spec for the problem and the intended behaviour, a design for the technical direction, and a breakdown of the work into tracer-bullet subtasks. Do NOT interview the user; just synthesize what you already know.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill. A repo's `docs/agents/issue-tracker.md` overrides it.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Design the system. Once the seams are agreed, settle the technical direction using the `<design-template>` below.

Approval agrees the intended behaviour and the technical direction; implementation stays open. Describe each part by the role it plays, and leave the classes, functions and files to the local plan each subtask writes when its work begins.

4. Break the work into subtasks. The design's **Deliberately Undecided** section already names what each subtask must settle; this step decides where the cuts fall.

Draft the work as **tracer bullets** — each a vertical slice, not a layer:

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests): vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each slice its **blocking edges**: the other slices that must complete before it can start. A slice with no blockers can start immediately.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own subtask blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a subtask blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify subtask; green is promised only there.

A feature that is genuinely one slice stays one slice. Do not invent a breakdown to have one.

5. Write the spec using the `<spec-template>` below, the design using the `<design-template>` below, and the breakdown as a numbered list showing, per slice, its **title**, what it **delivers** end to end, and what **blocks** it. Put all three to the user and wait.

One gate covers the set: behaviour, technical direction and the shape of the task graph are approved together. Ask whether the granularity feels right, whether each blocking edge genuinely gates its slice, and whether any slices should merge or split. Publish only once the user approves them together, revising and asking again after each change.

6. Publish. The spec is the parent task's description; the design attaches to that same task, separately addressable, so a later integration review can fetch the direction alone and diff the built architecture against it.

Where the feature is one slice, there is no umbrella. Publish it as a single task, exactly as before, and stop here:

```sh
KEY=$(bb tasks-plus create --title "$TITLE" --description-file "$SPEC" \
  --label ready-for-agent --json | jq -r '.task.key')
bb tasks-plus attachment add "$KEY" --file "$DESIGN" --name approved-plan.md
```

Otherwise create the parent first. It carries no triage label: the umbrella is not a unit of work, and `ready-for-agent` is the signal that an agent may pick something up.

```sh
KEY=$(bb tasks-plus create --title "$TITLE" --description-file "$SPEC" --json | jq -r '.task.key')
bb tasks-plus attachment add "$KEY" --file "$DESIGN" --name approved-plan.md
```

Then create one child per slice, in dependency order — blockers before dependents — writing each description from the `<slice-template>` below. Capture every key as you go, because the edges are recorded by key:

```sh
SLICE_1=$(bb tasks-plus create --title "$SLICE_1_TITLE" --description-file "$SLICE_1_BODY" \
  --label ready-for-agent --parent "$KEY" --json | jq -r '.task.key')
SLICE_2=$(bb tasks-plus create --title "$SLICE_2_TITLE" --description-file "$SLICE_2_BODY" \
  --label ready-for-agent --parent "$KEY" --json | jq -r '.task.key')
```

Finally record each blocking edge as a relation, once both of its ends exist:

```sh
bb tasks-plus blocker add "$SLICE_2" "$SLICE_1"   # slice 2 is blocked by slice 1
```

No further triage is needed.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- Technical clarifications from the developer
- Schema changes
- Specific interactions

Boundaries, interfaces, API contracts and architectural decisions belong in the design, which owns them. Keep this list to the behaviour.

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

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

The end-to-end behaviour this slice makes work, from the user's perspective, not
a layer-by-layer implementation list.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

</slice-template>

Parent and blocked-by are relations on this tracker, not prose sections: the
relation is the record, so they stay out of the body.

Avoid specific file paths and code snippets in a slice description; they go
stale fast. The prototype exception from the spec applies here too.
