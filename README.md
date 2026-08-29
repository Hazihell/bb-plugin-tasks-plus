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
