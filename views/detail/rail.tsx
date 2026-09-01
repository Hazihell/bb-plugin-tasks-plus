import { useState } from "react";
import type {
  Label,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "../../shared/contract.js";
import type { Preset } from "../../shared/contract.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import {
  PriorityIcon,
  StatusIcon,
  formatDueDate,
  isActiveThread,
} from "./meta.js";
import {
  DUE_DATE_PRESETS,
  localIsoDate,
  PRIORITY_LABELS,
  STATUS_LABELS,
  statusUnavailableReason,
} from "../list/lib.js";
import { DispatchControl } from "./threads.js";
import { defaultDispatchPreset, useLastPresetId } from "./last-preset.js";
import { describeBaseBranchOrigin } from "./base-branch-source.js";
import { describeDispatchTargetOrigin } from "./dispatch-target-source.js";
import {
  resolveDispatchTarget,
  type DispatchTargetResolution,
} from "../../shared/dispatch-target.js";
import {
  resolveBaseBranch,
  type BaseBranchResolution,
} from "../../shared/base-branch.js";
import { DEFAULT_COLOR } from "../manage/shared.js";
import {
  BbProjectLinkPicker,
  bbProjectLinkStateFor,
  emptyBbProjectLinkState,
  resolveBbProjectLink,
  type BbProjectLinkState,
} from "../manage/bb-project-link.js";
import type { BbProjectOption } from "../../shared/contract.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { cn, trimToNull } from "@/lib/utils";

export interface TaskPropertyUpdate {
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  baseBranch?: string | null;
  dispatchBbProjectId?: string | null;
  labelIds?: string[];
}

interface TaskPropertiesProps {
  task: Task;
  project: Project | undefined;
  labels: Label[] | undefined;
  threads: TaskThread[];
  onUpdate: (update: TaskPropertyUpdate) => void;
}

function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </span>
  );
}

function StatusMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  // The API refuses to move a blocked task into progress; the menu carries
  // that refusal in advance rather than letting the user find the wall.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName}>
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_STATUSES.map((status) => {
          const unavailableReason = statusUnavailableReason(task, status);
          return (
            <DropdownMenuItem
              key={status}
              disabled={unavailableReason !== null}
              onSelect={() => {
                if (unavailableReason === null) onUpdate({ status });
              }}
            >
              <StatusIcon status={status} />
              {STATUS_LABELS[status]}
              {unavailableReason !== null ? (
                <span className="text-2xs text-subtle-foreground">
                  {unavailableReason}
                </span>
              ) : null}
              {status === task.status ? (
                <Icon name="Check" className="ml-auto size-3.5" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName}>
          <PriorityIcon priority={task.priority} />
          {PRIORITY_LABELS[task.priority]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_PRIORITIES.map((priority) => (
          <DropdownMenuItem
            key={priority}
            onSelect={() => onUpdate({ priority })}
          >
            <PriorityIcon priority={priority} />
            {PRIORITY_LABELS[priority]}
            {priority === task.priority ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DueDateMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (dueDate: string | null) => {
    onUpdate({ dueDate });
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={triggerClassName}>
          <Icon name="Clock" className="size-3.5 shrink-0" />
          {task.dueDate ? formatDueDate(task.dueDate) : "Set due date"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2">
        <div className="flex flex-col">
          {DUE_DATE_PRESETS.map(([label, days]) => (
            <button
              key={label}
              type="button"
              className="flex items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => pick(localIsoDate(days))}
            >
              {label}
              <span className="text-xs text-muted-foreground">
                {formatDueDate(localIsoDate(days))}
              </span>
            </button>
          ))}
          <input
            type="date"
            aria-label="Due date"
            className="mt-1 h-7 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            value={task.dueDate ?? ""}
            onChange={(event) => {
              if (event.target.value) pick(event.target.value);
            }}
          />
          {task.dueDate ? (
            <button
              type="button"
              className="mt-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => pick(null)}
            >
              <Icon name="X" className="size-3.5" />
              Remove due date
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelsMenu({
  task,
  labels,
  onUpdate,
  children,
}: {
  task: Task;
  labels: Label[] | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  children: React.ReactNode;
}) {
  const rpc = useTasksRpc();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const toggle = (labelId: string) => {
    const next = task.labelIds.includes(labelId)
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];
    onUpdate({ labelIds: next });
  };

  // Inline label creation: from the query when it matches nothing, or from
  // the "New label" row when the project has no labels yet. The created
  // label is attached to the task right away.
  const createLabel = async (name: string) => {
    if (!name || creating) return;
    setCreating(true);
    try {
      const { label } = await rpc.call("createLabel", {
        projectId: task.projectId,
        name,
        color: DEFAULT_COLOR,
      });
      onUpdate({ labelIds: [...task.labelIds, label.id] });
      setQuery("");
    } finally {
      setCreating(false);
    }
  };

  const labelList = labels ?? [];
  return (
    <Popover onOpenChange={(open) => open || setQuery("")}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Add labels…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty
              className={query.trim() !== "" ? "p-1 text-left" : undefined}
            >
              {query.trim() !== "" ? (
                <button
                  type="button"
                  disabled={creating}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => void createLabel(query.trim())}
                >
                  <Icon name="Plus" className="size-3.5" />
                  Create “{query.trim()}”
                </button>
              ) : (
                "No labels in this project."
              )}
            </CommandEmpty>
            {labels !== undefined && labelList.length === 0 ? (
              <CommandGroup>
                <CommandItem
                  disabled={creating}
                  onSelect={() => {
                    const name = query.trim();
                    if (name) void createLabel(name);
                  }}
                >
                  <Icon name="Plus" className="size-3.5" />
                  New label{query.trim() ? ` “${query.trim()}”` : "…"}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {/* Rendered only when labels exist: an empty cmdk group still
                paints its p-1 padding, leaving a dead band under "New label…". */}
            {labelList.length > 0 ? (
              <CommandGroup>
                {labelList.map((label) => (
                  <CommandItem
                    key={label.id}
                    value={label.name}
                    onSelect={() => toggle(label.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1">{label.name}</span>
                    {task.labelIds.includes(label.id) ? (
                      <Icon name="Check" className="size-3.5" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The rail's dispatch-target row. It reads the bb project a dispatch would
 * actually spawn into and names the scope it came from; the only thing it
 * writes is the task's own target. The project's own link is configured
 * where it lives, in the manage panel's project dialog.
 */
function DispatchTargetMenu({
  task,
  /** Undefined until the ancestry walk behind the resolution has answered. */
  readout,
  /** What the task would fall back to if it named no target of its own. */
  inherited,
  bbProjects,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  readout: DispatchTargetResolution | undefined;
  inherited: DispatchTargetResolution | undefined;
  bbProjects: readonly BbProjectOption[];
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BbProjectLinkState>(
    emptyBbProjectLinkState,
  );
  // listBbProjects only knows the workspace's current projects; a target it
  // cannot name still has to read as something, so the id stands in.
  const nameFor = (bbProjectId: string) =>
    bbProjects.find((candidate) => candidate.id === bbProjectId)?.name ??
    bbProjectId;
  const attribution =
    readout === undefined ? null : describeDispatchTargetOrigin(readout);
  const save = (next: string | null) => {
    onUpdate({ dispatchBbProjectId: next });
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setState(bbProjectLinkStateFor(task.dispatchBbProjectId));
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Edit dispatch target"
          className={triggerClassName}
        >
          <Icon name="ArrowUpRight" className="size-3.5 shrink-0" />
          {readout === undefined ? (
            <span className="truncate text-muted-foreground">…</span>
          ) : readout.bbProjectId === null ? (
            <span className="truncate text-muted-foreground">
              Link a bb project…
            </span>
          ) : (
            <span
              className={cn(
                "min-w-0 truncate",
                readout.scope === "task" ? undefined : "text-muted-foreground",
              )}
              title={
                attribution === null
                  ? readout.bbProjectId
                  : `${readout.bbProjectId} · ${attribution}`
              }
            >
              {nameFor(readout.bbProjectId)}
              {attribution === null ? null : (
                <span className="text-2xs"> · {attribution}</span>
              )}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-1 text-2xs font-semibold text-muted-foreground">
          Dispatch target
        </div>
        <BbProjectLinkPicker
          state={state}
          onStateChange={setState}
          bbProjects={bbProjects}
          noneLabel="Inherit"
          ariaLabel="Task dispatch target"
        />
        <p className="mt-1.5 text-2xs text-muted-foreground">
          {inherited === undefined
            ? "Resolving where inheriting lands…"
            : inherited.bbProjectId === null
              ? "Inheriting lands on no bb project — dispatch has nowhere to spawn."
              : `Inheriting lands on ${nameFor(inherited.bbProjectId)} — ${describeDispatchTargetOrigin(inherited)}.`}
        </p>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {task.dispatchBbProjectId !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              onClick={() => save(null)}
            >
              <Icon name="X" className="size-3.5" />
              Inherit
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            className="h-7"
            onClick={() => {
              const resolved = resolveBbProjectLink(state);
              save(resolved === "" ? null : resolved);
            }}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The rail's base-branch row. It reads the branch a dispatch would actually
 * use and names the scope it came from; the only thing it writes is the
 * task's own branch. Wider scopes are configured where they live — the
 * project in the manage panel, the preset in its dialog.
 */
function BaseBranchMenu({
  task,
  readout,
  inherited,
  presetName,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  /** Undefined until the ancestry walk behind the resolution has answered. */
  readout: BaseBranchResolution | undefined;
  /** What the task would fall back to if it named no branch of its own. */
  inherited: BaseBranchResolution | undefined;
  presetName: string | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const attribution =
    readout === undefined ? null : describeBaseBranchOrigin(readout, presetName);
  const save = (next: string | null) => {
    onUpdate({ baseBranch: next });
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setBranch(task.baseBranch ?? "");
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Edit base branch"
          className={triggerClassName}
        >
          <Icon name="GitBranch" className="size-3.5 shrink-0" />
          {readout === undefined ? (
            <span className="truncate text-muted-foreground">…</span>
          ) : readout.branch === null ? (
            <span className="truncate text-muted-foreground">bb default</span>
          ) : (
            <span
              className={cn(
                "min-w-0 truncate",
                readout.scope === "task" ? undefined : "text-muted-foreground",
              )}
              title={
                attribution === null
                  ? readout.branch
                  : `${readout.branch} · ${attribution}`
              }
            >
              {readout.branch}
              {attribution === null ? null : (
                <span className="text-2xs"> · {attribution}</span>
              )}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <div className="mb-1 text-2xs font-semibold text-muted-foreground">
          Base branch
        </div>
        <Input
          value={branch}
          placeholder="inherit — leave empty"
          aria-label="Task base branch"
          onChange={(event) => setBranch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            save(trimToNull(branch));
          }}
          className="h-8"
        />
        <p className="mt-1.5 text-2xs text-muted-foreground">
          {inherited === undefined
            ? "Resolving where inheriting lands…"
            : inherited.branch === null
              ? "Inheriting lands on bb's default branch."
              : `Inheriting lands on ${inherited.branch} — ${describeBaseBranchOrigin(inherited, presetName)}.`}
        </p>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {task.baseBranch !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              onClick={() => save(null)}
            >
              <Icon name="X" className="size-3.5" />
              Inherit
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            className="h-7"
            onClick={() => save(trimToNull(branch))}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const RAIL_ROW_CLASS =
  "-mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-state-hover";

/** Right-hand properties rail (hidden below the container breakpoint). */
export function PropertiesRail({
  task,
  project,
  labels,
  threads,
  presets,
  onUpdate,
  onError,
  className,
}: TaskPropertiesProps & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) =>
    task.labelIds.includes(label.id),
  );
  const active = threads.filter(isActiveThread);
  // Fetched unconditionally: the picker needs the workspace list even when
  // the project is not linked yet.
  const bbProjects = useTasksQuery(
    async (query) => (await query.call("listBbProjects")).bbProjects,
    ["projects:changed"],
  );
  // Which preset supplies the fallback depends on which one a dispatch would
  // use, so the read-out reads the same remembered choice the button does.
  const lastPresetId = useLastPresetId();
  const dispatchPreset = defaultDispatchPreset(presets, lastPresetId);
  // The read-out resolves through the dispatch's own resolver, over an
  // ancestor lookup backed by RPC. Each id is fetched once, so resolving the
  // task's answer and its inherited fallback costs one walk between them.
  const baseBranch = useTasksQuery(
    async (query) => {
      const fetched = new Map<string, Task | null>();
      const getTask = async (taskId: string) => {
        const cached = fetched.get(taskId);
        if (cached !== undefined) return cached;
        const { task: ancestor } = await query.call("getTask", { taskId });
        fetched.set(taskId, ancestor);
        return ancestor;
      };
      const scopes = { project, preset: dispatchPreset, getTask };
      return {
        resolved: await resolveBaseBranch({ ...scopes, task }),
        inherited: await resolveBaseBranch({
          ...scopes,
          task: { ...task, baseBranch: null },
        }),
      };
    },
    ["tasks:changed"],
    [
      task.id,
      task.parentTaskId,
      task.baseBranch,
      project?.baseBranch,
      dispatchPreset?.baseBranch,
    ],
  );
  // The same shape as the base-branch read-out, over the dispatch's own
  // resolver: one cached getTask per id, and both answers off one walk.
  const dispatchTarget = useTasksQuery(
    async (query) => {
      const fetched = new Map<string, Task | null>();
      const getTask = async (taskId: string) => {
        const cached = fetched.get(taskId);
        if (cached !== undefined) return cached;
        const { task: ancestor } = await query.call("getTask", { taskId });
        fetched.set(taskId, ancestor);
        return ancestor;
      };
      const scopes = {
        project: { linkedBbProjectId: project?.linkedBbProjectId ?? null },
        getTask,
      };
      return {
        resolved: await resolveDispatchTarget({ ...scopes, task }),
        inherited: await resolveDispatchTarget({
          ...scopes,
          task: { ...task, dispatchBbProjectId: null },
        }),
      };
    },
    ["tasks:changed"],
    [
      task.id,
      task.parentTaskId,
      task.dispatchBbProjectId,
      project?.linkedBbProjectId,
    ],
  );
  return (
    <aside className={cn("w-56 shrink-0 py-10 pl-2 pr-6", className)}>
      <h2 className="mb-1.5 text-xs font-semibold text-muted-foreground">
        Properties
      </h2>
      <StatusMenu task={task} onUpdate={onUpdate} triggerClassName={RAIL_ROW_CLASS} />
      <PriorityMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={RAIL_ROW_CLASS}
      />
      <DueDateMenu task={task} onUpdate={onUpdate} triggerClassName={RAIL_ROW_CLASS} />

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Labels
      </div>
      <div className="flex flex-wrap items-center gap-1 py-0.5">
        {taskLabels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
        <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
          <button
            type="button"
            aria-label="Edit labels"
            className="inline-flex items-center rounded-md border border-dashed border-border px-1.5 py-0.5 text-muted-foreground hover:border-input hover:text-foreground"
          >
            <Icon name="Plus" className="size-3" />
          </button>
        </LabelsMenu>
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Project
      </div>
      <div className="flex items-center gap-2 py-0.5 text-sm">
        <span
          aria-hidden
          className="size-3 shrink-0 rounded-sm"
          style={{ backgroundColor: project?.color }}
        />
        <span className="truncate">{project?.name ?? "…"}</span>
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Dispatch target
      </div>
      <DispatchTargetMenu
        task={task}
        readout={dispatchTarget.data?.resolved}
        inherited={dispatchTarget.data?.inherited}
        bbProjects={bbProjects.data ?? []}
        onUpdate={onUpdate}
        triggerClassName={RAIL_ROW_CLASS}
      />

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Base branch
      </div>
      <BaseBranchMenu
        task={task}
        readout={baseBranch.data?.resolved}
        inherited={baseBranch.data?.inherited}
        presetName={dispatchPreset?.name}
        onUpdate={onUpdate}
        triggerClassName={RAIL_ROW_CLASS}
      />

      <div className="mt-2.5 py-0.5">
        <DispatchControl
          task={task}
          presets={presets}
          onError={onError}
          align="start"
          className="w-full"
        />
      </div>

      <div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
        Agents
      </div>
      <div className="flex flex-col gap-1 py-0.5 text-xs">
        {active.length > 0 ? (
          active.map((thread) => (
            <span
              key={thread.id}
              className="flex items-center gap-1.5 font-medium text-success"
            >
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-success"
              />
              <span className="truncate">
                {thread.presetName}{" "}
                {thread.liveStatus === "starting" ? "starting" : "working"}
              </span>
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">none active</span>
        )}
      </div>
    </aside>
  );
}

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground hover:border-input";

/** Compact property chips shown under the title when the rail is hidden.
 *  Carries the task's single DispatchControl on narrow layouts, so it also
 *  needs the rail's presets/onError wiring. */
export function InlineProperties({
  task,
  labels,
  presets,
  onUpdate,
  onError,
  className,
}: Omit<TaskPropertiesProps, "project" | "threads"> & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) =>
    task.labelIds.includes(label.id),
  );
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <StatusMenu task={task} onUpdate={onUpdate} triggerClassName={CHIP_CLASS} />
      <PriorityMenu task={task} onUpdate={onUpdate} triggerClassName={CHIP_CLASS} />
      <DueDateMenu task={task} onUpdate={onUpdate} triggerClassName={CHIP_CLASS} />
      {taskLabels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
        <button
          type="button"
          aria-label="Edit labels"
          className="inline-flex items-center rounded-md border border-dashed border-border px-2 py-1 text-muted-foreground hover:border-input hover:text-foreground"
        >
          <Icon name="Plus" className="size-3" />
        </button>
      </LabelsMenu>
      <DispatchControl
        task={task}
        presets={presets}
        onError={onError}
        className="ml-auto max-w-56"
      />
    </div>
  );
}
