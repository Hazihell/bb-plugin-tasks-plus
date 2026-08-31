import type { Preset } from "../../shared/contract.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  PERMISSION_LABELS,
  PERMISSION_MODES,
  describePresetEnvironment,
} from "./preset-dialog.js";

interface MachineOption {
  id: string;
  name: string;
}

/**
 * Read-only counterpart of `Field`: same label typography, but no `<label>`
 * because a view row has no control to point at.
 */
function ViewField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

/**
 * Full settings and instructions of a preset the user cannot change. Kept
 * apart from PresetDialog so the editor stays a single-purpose form: no draft
 * state, no submit path, and no per-control read-only branching.
 */
export function PresetViewDialog({
  open,
  onOpenChange,
  preset,
  machines,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: Preset;
  machines: readonly MachineOption[];
}) {
  const permission = PERMISSION_MODES.find(
    (mode) => mode === preset.permissionMode,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One dismiss action: the footer Close, not also a corner X. */}
      <DialogContent hideCloseButton className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{preset.name}</DialogTitle>
          <DialogDescription>
            This preset ships with the plugin and cannot be changed.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <ViewField label="Provider">
              <p className="text-sm">{preset.providerId}</p>
            </ViewField>
            <ViewField label="Model">
              <p className="font-mono text-xs">{preset.modelId}</p>
            </ViewField>
            <ViewField label="Reasoning">
              <p className="text-sm">{preset.reasoningLevel}</p>
            </ViewField>
            <ViewField label="Tier">
              <p className="text-sm">{preset.serviceTier ?? "—"}</p>
            </ViewField>
            <ViewField label="Permissions">
              <p className="text-sm">
                {permission
                  ? PERMISSION_LABELS[permission]
                  : preset.permissionMode}
              </p>
            </ViewField>
            <ViewField label="Execution environment">
              <p className="text-sm">
                {describePresetEnvironment(preset, machines)}
              </p>
            </ViewField>
          </div>
          <ViewField label="Instructions">
            {/* Multi-paragraph prose with a numbered list — rendered
                pre-wrapped so its line breaks survive. */}
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">
              {preset.instructions === "" ? "—" : preset.instructions}
            </p>
          </ViewField>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
