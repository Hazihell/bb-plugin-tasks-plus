# Tasks Plus

A personal fork of BB's built-in **Tasks** plugin, with extra features layered
on top.

Tasks is a Linear-style tracker inside BB for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work. It
provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

## Attribution

This plugin is a fork of [`plugins/tasks`](https://github.com/get-bb/bb/tree/main/plugins/tasks)
from [get-bb/bb](https://github.com/get-bb/bb), copyright (c) 2026 Michael Yong,
used under the MIT License. The `LICENSE` file is carried over unchanged.

Forked at tag `desktop-v0.40.0`. It is **not** affiliated with or endorsed by
the BB project. Report issues with this fork here, not upstream.

Changes from upstream:

- Renamed to plugin id `tasks-plus` so it installs alongside the builtin
  (BB reserves the id `tasks` for its bundled copy).
- CLI command is `bb tasks-plus`; the agent skill is named `tasks-plus`.
- Shared UI is vendored from the `@bb` shadcn registry instead of the
  monorepo-private `@bb/shared-ui` package.

The `to-spec-and-design` skill is derived from Matt Pocock's `to-spec` and
`to-tickets`, renamed and extended with a system-design phase. It is not
affiliated with or endorsed by its author; report issues with this fork here,
not upstream.

## Install

```sh
git clone https://github.com/Hazihell/bb-plugin-tasks-plus
bb plugin install ./bb-plugin-tasks-plus
```

Disable the builtin first so you have one board and one database:

```sh
bb plugin disable tasks
```

To carry your existing tasks over, copy the builtin's database once while both
plugins are disabled:

```sh
cp ~/.bb/plugins/tasks/data.db ~/.bb/plugins/tasks-plus/data.db
```

The plugin adds the Tasks Plus sidebar panel, the `bb tasks-plus` command, and
an agent skill that teaches workers how to report progress back to tasks.

## Development

```sh
npm install
npm run typecheck
npm test
bb plugin dev        # rebuild + reload on save
```

## Syncing with upstream

Diff `plugins/tasks` between two `get-bb/bb` release tags and apply the patch
here. The only thing needing a redo is the import rewrite:

- `@bb/shared-ui/lib/utils` → `@/lib/utils`
- `@bb/shared-ui/hooks/<x>` → `@/components/ui/hooks/<x>`
- `@bb/shared-ui/<x>` → `@/components/ui/<x>`
- `@bb/plugin-sdk` → `@get-bb/plugin-sdk`
- `/plugins/tasks/` → `/plugins/tasks-plus/`

## Agent skills

The plugin ships the skills under `skills/`:

- `tasks-plus` — teaches workers how to report progress back to tasks.
- `narrative-review` — writes a reviewed change up for a human as a `review`
  artifact: concerns grouped by behaviour rather than by file, each with the
  reason it exists and the few line ranges worth reading, pinned to one commit.
- `to-spec-and-design` — turns a conversation into a spec, a system design and
  a breakdown into tracer-bullet subtasks, all approved at one gate. It
  publishes the parent task with the spec as its description and the design as
  an `approved-plan.md` attachment, then one child per slice in dependency
  order, with parent and blocked-by as real relations. A feature that is one
  slice publishes as one task.
- `review-record` — reviews the changes since a fixed point along two parallel
  axes, Standards and Spec, and persists the aggregate as a `review_result`
  artifact on the originating task, with one comment pointing at it. The task is
  both the spec the Spec axis is briefed from and the record's destination, so
  one lookup fixes what is judged and where the result lands.

`to-spec-and-design` is a fork of Matt Pocock's `to-spec`, extended with a
system-design phase and with the decomposition step from his `to-tickets`, and
renamed so it sits beside the originals rather than replacing them. Nothing
merges them: when upstream changes, read the diff and carry over what is worth
carrying.

If you also install Matt's skills, keep both — they do different jobs, and the
distinct names mean neither shadows the other.
