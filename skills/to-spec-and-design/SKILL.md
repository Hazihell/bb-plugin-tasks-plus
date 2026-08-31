---
name: to-spec-and-design
description: "Turn the current conversation into a spec and a system design and publish both to the issue tracker. Use when a discussed feature is ready to write up, or when a spec needs its technical direction agreed at the same gate."
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces two documents: a spec for the problem and the intended behaviour, a design for the technical direction. Do NOT interview the user; just synthesize what you already know.

Tasks Plus is the tracker: `bb tasks-plus`, commands in the `tasks-plus` skill. A repo's `docs/agents/issue-tracker.md` overrides it.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Design the system. Once the seams are agreed, settle the technical direction using the `<design-template>` below.

Approval agrees the intended behaviour and the technical direction; implementation stays open. Describe each part by the role it plays, and leave the classes, functions and files to the local plan each subtask writes when its work begins.

4. Write the spec using the `<spec-template>` below and the design using the `<design-template>` below, then put both to the user and wait. One gate covers the pair: publish only once the user approves them together, revising and asking again after each change.

5. Publish both onto the same task, separately addressable, so a later integration review can fetch the direction alone and diff the built architecture against it.

The spec is the task description. Create the task and capture its key:

```sh
KEY=$(bb tasks-plus create --title <title> --description-file <path> --label ready-for-agent --json | jq -r '.task.key')
```

The design attaches to that task as the approved plan:

```sh
bb tasks-plus attachment add "$KEY" --file <path> --name approved-plan.md
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
