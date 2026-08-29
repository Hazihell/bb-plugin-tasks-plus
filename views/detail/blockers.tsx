import { useState } from "react";
import type { Project, Task, TaskBlocker } from "../../shared/contract.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { StatusIcon } from "./meta.js";
import { isBlockerResolved, STATUS_LABELS } from "../list/lib.js";
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
import { cn } from "@/lib/utils";

/** Ceiling on the cross-project candidate list; the search box narrows it. */
const CANDIDATE_LIMIT = 30;

/**
 * One blocker (or blocked) task as a navigable row, shaped like the sub-task
 * rows above it. Resolved blockers are not removed from the list: the settled
 * row *is* the record that this task was once blocked by that one, which is
 * why nothing here writes a comment or an event when a blocker closes.
 */
function RelationRow({
  entry,
  projects,
  showProject,
  onOpen,
  onRemove,
}: {
  entry: TaskBlocker;
  projects: readonly Project[];
  /** True when the related task lives in another project than this task. */
  showProject: boolean;
  onOpen: () => void;
  /** Omitted on the reverse ("blocking") list, which is not editable here. */
  onRemove?: () => void;
}) {
  const resolved = isBlockerResolved(entry.status);
  const project = projects.find((candidate) => candidate.id === entry.projectId);
  return (
    <div className="flex h-8 items-center border-b border-border-hairline">
      <button
        type="button"
        title={STATUS_LABELS[entry.status]}
        onClick={onOpen}
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-0.5 text-left text-sm hover:bg-state-hover"
      >
        <StatusIcon status={entry.status} />
        <span className="shrink-0 text-xs text-muted-foreground">
          {entry.key}
        </span>
        <span
          className={cn(
            "min-w-0 truncate",
            resolved && "text-muted-foreground line-through",
          )}
        >
          {entry.title}
        </span>
        {resolved ? (
          <span className="shrink-0 text-2xs text-subtle-foreground">
            {STATUS_LABELS[entry.status]}
          </span>
        ) : null}
        {showProject ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span
              aria-hidden
              className="size-2 rounded-sm"
              style={{ backgroundColor: project?.color }}
            />
            {project?.name ?? "Other project"}
          </span>
        ) : null}
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove blocker ${entry.key}`}
          onClick={onRemove}
          className="ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
        >
          <Icon name="X" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Cross-project blocker picker, modelled on the new-task dialog's parent
 * picker. Search runs on the server (`listTasks` without a project filter),
 * so cmdk's own filtering is switched off — the visible rows are exactly the
 * server's answer. A rejected relation (cycle, self) stays on the picker as a
 * readable message instead of dismissing it.
 */
function AddBlockerPicker({
  task,
  projects,
  excludedIds,
  onAdd,
}: {
  task: Task;
  projects: readonly Project[];
  excludedIds: ReadonlySet<string>;
  onAdd: (blockerTaskId: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = query.trim();
  const candidates = useTasksQuery(
    async (rpc) =>
      open
        ? (
            await rpc.call("listTasks", {
              ...(trimmed === "" ? {} : { search: trimmed }),
              limit: CANDIDATE_LIMIT,
            })
          ).tasks
        : [],
    ["tasks:changed"],
    [open, trimmed],
  );
  const rows = (candidates.data ?? []).filter(
    (candidate) =>
      candidate.id !== task.id && !excludedIds.has(candidate.id),
  );

  const pick = async (blockerTaskId: string) => {
    if (busy) return;
    setBusy(true);
    const message = await onAdd(blockerTaskId);
    setBusy(false);
    setError(message);
    if (message === null) {
      setOpen(false);
      setQuery("");
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery("");
          setError(null);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <Icon name="Plus" className="size-3" />
          Add blocker
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search tasks in any project…"
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              setError(null);
            }}
          />
          <CommandList>
            <CommandEmpty>No matching task.</CommandEmpty>
            {rows.length > 0 ? (
              <CommandGroup>
                {rows.map((candidate) => {
                  const project = projects.find(
                    (entry) => entry.id === candidate.projectId,
                  );
                  return (
                    <CommandItem
                      key={candidate.id}
                      value={candidate.id}
                      disabled={busy}
                      onSelect={() => void pick(candidate.id)}
                    >
                      <StatusIcon status={candidate.status} />
                      <span className="shrink-0 font-medium text-muted-foreground">
                        {candidate.key}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {candidate.title}
                      </span>
                      {candidate.projectId !== task.projectId ? (
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {project?.name ?? "Other project"}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
        {error ? (
          <p
            role="alert"
            className="border-t border-border-hairline px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Both directions of the blocker relation for one task. Nothing here writes
 * `blocked`: the flag on the task is derived, and this section only edits the
 * relations it is derived from. Rendered whenever either direction is
 * non-empty, plus always the "Add blocker" affordance, so a task with no
 * relations still offers the entry point without paying for a header.
 */
export function BlockersSection({
  task,
  onError,
}: {
  task: Task;
  /** Toast channel; server refusals surface here rather than being dropped. */
  onError: (message: string) => void;
}) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();

  const blockers = useTasksQuery(
    async (query) =>
      (await query.call("listTaskBlockers", { taskId: task.id })).blockers,
    ["tasks:changed"],
    [task.id],
  );
  const blocking = useTasksQuery(
    async (query) =>
      (await query.call("listTaskBlocking", { taskId: task.id })).blocking,
    ["tasks:changed"],
    [task.id],
  );
  const projects = useTasksQuery(
    async (query) => (await query.call("listProjects", {})).projects,
    ["projects:changed"],
  );

  const blockerList = blockers.data ?? [];
  const blockingList = blocking.data ?? [];
  const projectList = projects.data ?? [];
  const excludedIds = new Set(blockerList.map((entry) => entry.id));

  // Returns the refusal message for the picker to show, or null on success.
  const add = async (blockerTaskId: string): Promise<string | null> => {
    try {
      const result = await rpc.call("addTaskBlocker", {
        blockerTaskId,
        blockedTaskId: task.id,
      });
      if (!result.ok) return result.error.message;
      blockers.refresh();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const remove = async (blockerTaskId: string) => {
    try {
      await rpc.call("removeTaskBlocker", {
        blockerTaskId,
        blockedTaskId: task.id,
      });
      blockers.refresh();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  const open = (taskKey: string) =>
    navigation.go({ kind: "task", taskKey });

  return (
    <section className="mt-5">
      <h2 className="mb-1 text-2xs font-semibold text-muted-foreground">
        Blocked by
      </h2>
      {blockerList.map((entry) => (
        <RelationRow
          key={entry.id}
          entry={entry}
          projects={projectList}
          showProject={entry.projectId !== task.projectId}
          onOpen={() => open(entry.key)}
          onRemove={() => void remove(entry.id)}
        />
      ))}
      <AddBlockerPicker
        task={task}
        projects={projectList}
        excludedIds={excludedIds}
        onAdd={add}
      />

      {blockingList.length > 0 ? (
        <>
          <h2 className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">
            Blocking
          </h2>
          {blockingList.map((entry) => (
            <RelationRow
              key={entry.id}
              entry={entry}
              projects={projectList}
              showProject={entry.projectId !== task.projectId}
              onOpen={() => open(entry.key)}
            />
          ))}
        </>
      ) : null}
    </section>
  );
}
