import { useState } from "react";
import type { BbProjectOption, Folder, Project } from "../../shared/contract.js";
import type { TasksRpc } from "../../shell/data.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorSwatchPicker, Field } from "./shared.js";
import {
  BbProjectLinkPicker,
  bbProjectLinkStateFor,
  resolveBbProjectLink,
  type BbProjectLinkState,
} from "./bb-project-link.js";

const NO_FOLDER = "__none__";

export interface ProjectDraft {
  name: string;
  color: string;
  folderId: string | null;
  link: BbProjectLinkState;
  /** Empty means "no project branch" — dispatches fall through to the preset. */
  baseBranch: string;
}

export function projectDraft(project: Project): ProjectDraft {
  return {
    name: project.name,
    color: project.color,
    folderId: project.folderId,
    link: bbProjectLinkStateFor(project.linkedBbProjectId),
    baseBranch: project.baseBranch ?? "",
  };
}

/**
 * Nest a folder under its parent for display; the sidebar only nests one
 * level, so a single parent lookup names any folder in full.
 */
export function folderPathName(
  folders: readonly Folder[],
  folderId: string,
): string {
  const folder = folders.find((entry) => entry.id === folderId);
  if (!folder) return "Folder";
  const parent = folder.parentFolderId
    ? folders.find((entry) => entry.id === folder.parentFolderId)
    : null;
  return parent ? `${parent.name} / ${folder.name}` : folder.name;
}

/**
 * Write a dialog draft back through updateProject — the one call that owns
 * every field this dialog edits. A blank branch is sent as null so "no
 * branch" keeps a single spelling; the contract rejects the empty string.
 */
export async function saveProjectDraft(
  rpc: TasksRpc,
  project: Project,
  draft: ProjectDraft,
): Promise<void> {
  const linked = resolveBbProjectLink(draft.link);
  const baseBranch = draft.baseBranch.trim();
  await rpc.call("updateProject", {
    projectId: project.id,
    name: draft.name.trim(),
    color: draft.color,
    folderId: draft.folderId,
    linkedBbProjectId: linked === "" ? null : linked,
    baseBranch: baseBranch === "" ? null : baseBranch,
  });
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  folders,
  bbProjects,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  folders: readonly Folder[];
  bbProjects: readonly BbProjectOption[];
  /** Resolves to an error message, or null when the save landed. */
  onSave: (draft: ProjectDraft) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<ProjectDraft>(() => projectDraft(project));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof ProjectDraft>(key: K, value: ProjectDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const canSubmit = draft.name.trim() !== "" && !submitting;

  const submit = () => {
    setSubmitting(true);
    setError(null);
    onSave(draft)
      .then((saveError) => {
        if (saveError !== null) {
          setError(saveError);
          return;
        }
        onOpenChange(false);
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (canSubmit) submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Settings shared by every task in {project.prefix}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Name">
            <Input
              autoFocus
              value={draft.name}
              aria-label="Project name"
              placeholder="e.g. Tasks Plugin"
              onChange={(event) => set("name", event.target.value)}
              className="h-8"
            />
          </Field>
          <Field label="Color">
            <ColorSwatchPicker
              value={draft.color}
              onChange={(color) => set("color", color)}
            />
          </Field>
          <Field label="Folder">
            <Select
              value={draft.folderId ?? NO_FOLDER}
              onValueChange={(value) =>
                set("folderId", value === NO_FOLDER ? null : value)
              }
            >
              <SelectTrigger aria-label="Folder" className="h-8">
                <SelectValue>
                  {draft.folderId
                    ? folderPathName(folders, draft.folderId)
                    : "No folder"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FOLDER}>No folder</SelectItem>
                {folders.map((folder) => (
                  <SelectItem key={folder.id} value={folder.id}>
                    {folderPathName(folders, folder.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Linked bb project"
            hint="Optional. Linking a bb project enables dispatching to agents."
          >
            <BbProjectLinkPicker
              state={draft.link}
              onStateChange={(link) => set("link", link)}
              bbProjects={bbProjects}
            />
          </Field>
          <Field
            label="Base branch"
            hint="Tasks without their own branch start here. Leave empty to fall through to the preset."
          >
            <Input
              value={draft.baseBranch}
              placeholder="preset default — leave empty"
              aria-label="Project base branch"
              onChange={(event) => set("baseBranch", event.target.value)}
              className="h-8"
            />
          </Field>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {draft.baseBranch.trim() !== "" ? (
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-muted-foreground"
              onClick={() => set("baseBranch", "")}
            >
              Clear base branch
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSubmit} onClick={submit}>
            Save project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
