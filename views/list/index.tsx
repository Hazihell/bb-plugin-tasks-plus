import { useEffect, useMemo, useRef, useState } from "react";
import type { Label, Task, TaskStatus } from "../../shared/contract.js";
import { useProjects } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { NewTaskDialog } from "../manage/new-task-dialog.js";
import { DetailToasts, useDetailToasts } from "../detail/toast.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useLabels, useListTasks, useTaskListMeta } from "./data.js";
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  ListFilterBar,
  type ListFilterState,
} from "./filter-bar.js";
import {
  listPreferenceScope,
  loadListPreference,
  storeListPreference,
  type ListPreference,
} from "./list-preference.js";
import type { TaskSort } from "../../shared/pagination.js";
import { StatusIcon } from "./icons.js";
import {
  listScrollScopeKey,
  useListScrollRestoration,
} from "./scroll-restoration.js";
import {
  groupTasksByStatus,
  labelFilterOptions,
  selectedLabelIds,
  STATUS_LABELS,
} from "./lib.js";
import { editedTasks, matchesFilters } from "./optimistic.js";
import { partitionTasks } from "./tree.js";
import { useListTaskEdits } from "./use-task-edits.js";
import { TaskRow } from "./row.js";

interface ListViewProps {
  /** null renders the cross-project "All tasks" list. */
  projectId: string | null;
  /** Only tasks with agents currently working (the Active route). */
  activeOnly?: boolean;
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon name={icon} className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

function LoadingRows() {
  return (
    <DelayedLoading>
      <div className="px-3.5 pt-3">
        <Skeleton className="mb-3 h-4 w-28" />
        {Array.from({ length: 7 }, (_, index) => (
          <div
            key={index}
            className="flex h-[34px] items-center gap-2 border-b border-border-hairline"
          >
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

export function ListView({ projectId, activeOnly = false }: ListViewProps) {
  const navigation = useTasksNavigation();
  const projects = useProjects();
  const { toasts, push, dismiss } = useDetailToasts();
  const preferenceScope = listPreferenceScope(projectId, activeOnly);
  const [preference, setPreference] = useState<ListPreference>(() =>
    loadListPreference(preferenceScope),
  );
  // Remounts already re-read storage; this covers prop-scope changes if the
  // same ListView instance is reused across routes.
  useEffect(() => {
    setPreference(loadListPreference(preferenceScope));
  }, [preferenceScope]);
  const filters = preference.filters;
  const sort = preference.sort;
  const isCollapsed = (status: TaskStatus) =>
    preference.collapsedStatuses.includes(status);
  const setFilters = (next: ListFilterState) => {
    updatePreference((current) => ({ ...current, filters: next }));
  };
  const setSort = (next: TaskSort) => {
    updatePreference((current) => ({ ...current, sort: next }));
  };
  // Whether a status group shows its rows is a preference, not a reading
  // posture: hiding Backlog and Done should still hold after a reload, per
  // list surface, exactly like the filters and the sort above it.
  const toggleStatusCollapsed = (status: TaskStatus) => {
    updatePreference((current) => ({
      ...current,
      collapsedStatuses: current.collapsedStatuses.includes(status)
        ? current.collapsedStatuses.filter((value) => value !== status)
        : [...current.collapsedStatuses, status],
    }));
  };
  function updatePreference(
    next: (current: ListPreference) => ListPreference,
  ): void {
    setPreference((current) => {
      const updated = next(current);
      storeListPreference(preferenceScope, updated);
      return updated;
    });
  }
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // Parent whose "New subtask" menu item was chosen; drives the second dialog.
  const [subtaskParent, setSubtaskParent] = useState<Task | null>(null);
  // Which parents are showing their subtasks. Collapsed by default, and
  // remembered per list surface like the filters and the collapsed groups: a
  // parent a user opened to work under is a standing choice, not a posture
  // they should have to retake after every reload.
  const expandedParents = useMemo(
    (): ReadonlySet<string> => new Set(preference.expandedParents),
    [preference.expandedParents],
  );
  const toggleExpanded = (taskId: string) => {
    updatePreference((current) => ({
      ...current,
      expandedParents: current.expandedParents.includes(taskId)
        ? current.expandedParents.filter((value) => value !== taskId)
        : [...current.expandedParents, taskId],
    }));
  };

  const labelProjectIds = useMemo(
    () =>
      projectId !== null
        ? [projectId]
        : (projects.data ?? []).map((project) => project.id),
    [projectId, projects.data],
  );
  const labels = useLabels(labelProjectIds);
  const labelOptions = useMemo(
    () => labelFilterOptions(labels.data ?? []),
    [labels.data],
  );
  // null = no label filter. Once the catalog is loaded, unresolved selected
  // names become an active empty id list so the filter matches nothing (not
  // every task). While labels are still loading, defer the filter to avoid a
  // flash of empty results before options arrive.
  const labelIds = useMemo((): readonly string[] | null => {
    if (filters.labelNames.length === 0) return null;
    if (labels.data === undefined) return null;
    return selectedLabelIds(labelOptions, filters.labelNames);
  }, [filters.labelNames, labelOptions, labels.data]);

  const tasksQuery = useListTasks(projectId, activeOnly);
  const meta = useTaskListMeta(tasksQuery.data);
  const edits = useListTaskEdits(tasksQuery.data, (message) => push(message));

  const labelsById = useMemo(
    () => new Map((labels.data ?? []).map((label) => [label.id, label])),
    [labels.data],
  );
  const labelsByProject = useMemo(() => {
    const map = new Map<string, Label[]>();
    for (const label of labels.data ?? []) {
      const bucket = map.get(label.projectId);
      if (bucket) bucket.push(label);
      else map.set(label.projectId, [label]);
    }
    return map;
  }, [labels.data]);
  const projectsById = useMemo(
    () =>
      new Map((projects.data ?? []).map((project) => [project.id, project])),
    [projects.data],
  );

  // Optimistic edits are overlaid on the flat list, before it is split into
  // parents and subtasks, so an edited row — either kind — moves to its new
  // status group or its new slot inside a parent's block immediately instead
  // of waiting for the server refetch.
  const editedList = useMemo(() => {
    if (tasksQuery.data === undefined) return undefined;
    return editedTasks(tasksQuery.data, edits.entries);
  }, [tasksQuery.data, edits.entries]);
  // The status/priority/label filters are a claim about parents only: a
  // matching parent brings every one of its subtasks whatever their own
  // values, and a subtask never renders without its parent. So every count the
  // chrome shows — the filter bar's and each status header's — counts parents.
  const tree = useMemo(
    () =>
      partitionTasks(editedList ?? [], sort, (task) =>
        matchesFilters(task, filters.statuses, filters.priorities, labelIds),
      ),
    [editedList, sort, filters.statuses, filters.priorities, labelIds],
  );
  const groups = useMemo(() => groupTasksByStatus(tree.parents), [tree.parents]);

  const showProject = projectId === null;
  const filtered = hasActiveFilters(filters);

  // The route scope is the fetch identity across views: All, Active, or one
  // project. Switching it reuses this ListView instance, whose query still
  // holds the previous route's result, so the body below must read as loading
  // until this route's own fetch settles: returning from an empty Active to
  // All must not present Active's emptiness as "No tasks yet". Narrower than
  // `scopeKey` on purpose, so filter and sort changes keep painting the rows
  // they already have. State, not a ref: settling has to rerender the body —
  // and, below, has to lower the scroll restorer's `loading` flag in a render
  // of its own rather than in a later unrelated one.
  const routeScope = `${projectId ?? "-"}/${activeOnly}`;
  const [settledRouteScope, setSettledRouteScope] = useState(routeScope);
  const routeScopeChanged = settledRouteScope !== routeScope;
  const previousRouteScope = useRef(routeScope);
  useEffect(() => {
    // The query's own effect flips `isLoading` in this same commit, but this
    // effect still reads the previous render's value, so the commit that
    // changes the route scope must never settle it; a later resolved commit
    // does.
    const routeScopeJustChanged = previousRouteScope.current !== routeScope;
    previousRouteScope.current = routeScope;
    if (!routeScopeJustChanged && !tasksQuery.isLoading) {
      setSettledRouteScope(routeScope);
    }
  }, [routeScope, tasksQuery.isLoading, tasksQuery.data]);

  // Remember/restore the list's scroll offset per distinct list+filter+sort
  // context, so opening a task and returning (or refreshing) lands where the
  // user left off. Restore only once the real rows have loaded.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scopeKey = listScrollScopeKey({ projectId, activeOnly, filters, sort });
  useListScrollRestoration(scrollRef, scopeKey, {
    contentReady: tasksQuery.data !== undefined && tasksQuery.data.length > 0,
    // Only a route change refetches — filters and sort are applied to rows we
    // already hold — so the route scope is the entire "more rows are still
    // coming" signal. Reusing it here (rather than a ref keyed on the wider
    // `scopeKey`) means a filter or sort change settles in the very render
    // that made it, leaving no restore target pending for a later expand or
    // invalidation to act on.
    loading: tasksQuery.isLoading || routeScopeChanged,
    revision: tasksQuery.data?.length ?? 0,
  });

  /** Row props that read the same for a parent and for one of its subtasks. */
  const rowProps = (task: Task) => ({
    task,
    meta: meta.data?.get(task.id),
    project: projectsById.get(task.projectId),
    showProject,
    labelsById,
    projectLabels: labelsByProject.get(task.projectId) ?? [],
    onEdit: edits.edit,
    onOpen: () => navigation.go({ kind: "task", taskKey: task.key }),
    pending: edits.pending.has(task.id),
  });

  let body: React.ReactNode;
  if (
    routeScopeChanged ||
    tasksQuery.data === undefined ||
    editedList === undefined
  ) {
    // While a changed route scope is in flight, any held data or error is the
    // previous route's; only a settled result may claim this scope is empty
    // or broken.
    body =
      !routeScopeChanged && tasksQuery.error !== null ? (
        <EmptyState
          icon="AlertCircle"
          title="Couldn't load tasks"
          description={tasksQuery.error}
        />
      ) : (
        <LoadingRows />
      );
  } else if (tree.parents.length === 0) {
    if (filtered) {
      body = (
        <EmptyState
          icon="Search"
          title="No tasks match these filters"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFilters(EMPTY_FILTERS)}
            >
              Clear filters
            </Button>
          }
        />
      );
    } else if (activeOnly) {
      body = (
        <EmptyState
          icon="Zap"
          title="No agents working right now"
          description="Dispatch a task to an agent preset and it will show up here while it runs."
        />
      );
    } else {
      body = (
        <EmptyState
          icon="ListTodo"
          title="No tasks yet"
          description="Create the first task to start tracking work."
          action={
            <Button size="sm" onClick={() => setNewTaskOpen(true)}>
              <Icon name="Plus" className="size-3.5" />
              New task
            </Button>
          }
        />
      );
    }
  } else {
    body = groups.map((group) => (
      <section key={group.status}>
        {/*
          Opaque canvas fill + stacking above row chrome: task rows keep
          relative z-10 property editors so they stay clickable above the
          stretched open overlay. The stuck status header must sit higher
          (z-20) with an opaque theme canvas token or those controls and
          titles paint on top while scrolling and read as a transparent bar.
          bg-background maps to --canvas via the host theme (same family as
          card); do not use surface-scrim or hardcoded colors here.
          Hairline bottom border separates the pin band from scrolling rows
          (same token family as the filter bar and row dividers).
          The whole bar is the collapse control, and its hover cue deliberately
          stays off the fill: a translucent state token here would let rows
          show through the stuck bar. The chevron brightening carries it.
        */}
        <button
          type="button"
          data-status-group-header={group.status}
          aria-expanded={!isCollapsed(group.status)}
          onClick={() => toggleStatusCollapsed(group.status)}
          className="group sticky top-0 z-20 isolate flex w-full items-center gap-2 border-b border-border-hairline bg-background px-3.5 pb-1.5 pt-2.5 text-left text-sm font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Icon
            aria-hidden
            name={isCollapsed(group.status) ? "ChevronRight" : "ChevronDown"}
            className="size-3.5 shrink-0 text-subtle-foreground transition-colors group-hover:text-foreground"
          />
          <StatusIcon status={group.status} />
          {STATUS_LABELS[group.status]}
          <span className="text-xs font-normal tabular-nums text-subtle-foreground">
            {group.tasks.length}
          </span>
        </button>
        {isCollapsed(group.status)
          ? null
          : group.tasks.map((task) => {
              const children = tree.childrenByParent.get(task.id) ?? [];
              const expanded = expandedParents.has(task.id);
              return (
                <div key={task.id}>
                  <TaskRow
                    {...rowProps(task)}
                    {...(children.length > 0
                      ? {
                          expansion: {
                            childCount: children.length,
                            expanded,
                            onToggle: () => toggleExpanded(task.id),
                          },
                        }
                      : {})}
                    onNewSubtask={() => setSubtaskParent(task)}
                  />
                  {expanded && children.length > 0 ? (
                    /* Subtasks live in their parent's group whatever their own
                       status, so the nested block is indented behind a hairline
                       rail: the cue that the header above it counts and claims
                       parents only. Same token family as the row dividers.
                       The rail is also the parent's collapse control, so a long
                       block can be closed from its foot without scrolling back
                       up to the chevron. It is a plain div, not a button: the
                       chevron above already announces this exact action, so the
                       rail is hidden from assistive tech and must not be
                       focusable at all — a focusable element absent from the
                       accessibility tree is a trap.
                       Its width holds the indent the old ml-3.5 + border + pl-3
                       produced, so subtask titles keep their alignment. */
                    <div className="flex">
                      <div
                        data-subtask-rail={task.key}
                        aria-hidden
                        onClick={() => toggleExpanded(task.id)}
                        className="ml-3.5 w-[13px] shrink-0 cursor-pointer border-l border-border-hairline hover:bg-state-active"
                      />
                      <div className="min-w-0 flex-1">
                        {children.map((child) => (
                          <TaskRow key={child.id} {...rowProps(child)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
      </section>
    ));
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ListFilterBar
        filters={filters}
        onChange={setFilters}
        sort={sort}
        onSortChange={setSort}
        labelOptions={labelOptions}
        taskCount={editedList === undefined ? undefined : tree.parents.length}
      />
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto @container"
      >
        {body}
      </div>
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={projectId}
      />
      {/* Separate instance so the subtask draft is seeded from its parent —
          the dialog reads `defaultParentTaskId` when it opens. */}
      {subtaskParent !== null ? (
        <NewTaskDialog
          open
          onOpenChange={(open) => {
            if (!open) setSubtaskParent(null);
          }}
          projectId={subtaskParent.projectId}
          defaultParentTaskId={subtaskParent.id}
        />
      ) : null}
      <DetailToasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
