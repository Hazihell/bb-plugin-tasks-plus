import { useState } from "react";
import type { ReviewDraftComment } from "../../shared/contract.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";

/**
 * The pointer gestures a comment box needs are the same ones the diff uses to
 * select lines. The renderer listens on an ancestor of the projected slot, so
 * a box that does not claim its own gestures cannot be dragged through.
 */
const claimPointerGestures = {
  onPointerDown: (event: { stopPropagation: () => void }) =>
    event.stopPropagation(),
};

interface CommentComposerProps {
  /** What the box is attached to, said in one line above the field. */
  context: string;
  initialBody?: string;
  submitLabel: string;
  onSubmit: (body: string) => Promise<boolean>;
  onCancel: () => void;
}

/** An unsent comment being written. Blank is not a comment, so it cannot be sent. */
export function CommentComposer({
  context,
  initialBody = "",
  submitLabel,
  onSubmit,
  onCancel,
}: CommentComposerProps) {
  const [body, setBody] = useState(initialBody);
  const [busy, setBusy] = useState(false);
  const blank = body.trim().length === 0;

  return (
    <div
      className="rounded-md border border-border bg-card p-2"
      {...claimPointerGestures}
    >
      <div className="mb-1.5 truncate font-mono text-2xs text-muted-foreground">
        {context}
      </div>
      <Textarea
        autoFocus
        rows={3}
        value={body}
        placeholder="Leave a comment"
        aria-label="Comment"
        className="min-h-16 text-sm"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="mt-1.5 flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={blank || busy}
          onClick={async () => {
            setBusy(true);
            const saved = await onSubmit(body.trim());
            setBusy(false);
            // A failed save keeps the box open with the text still in it; the
            // store says what went wrong.
            if (saved) onCancel();
          }}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

interface DraftCommentCardProps {
  comment: ReviewDraftComment;
  onSave: (body: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}

/**
 * One unsent comment where it was written. It stays editable and removable
 * for as long as it is a draft — once the round is submitted the artifact is
 * the record and this card is gone.
 */
export function DraftCommentCard({
  comment,
  onSave,
  onDelete,
}: DraftCommentCardProps) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <CommentComposer
        context="Editing an unsent comment"
        initialBody={comment.body}
        submitLabel="Save"
        onSubmit={onSave}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div
      className="rounded-md border border-border bg-card p-2 text-sm"
      {...claimPointerGestures}
    >
      <div className="flex items-start gap-2">
        <Icon
          name="MessageSquare"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">
          {comment.body}
        </p>
        <button
          type="button"
          aria-label="Edit comment"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(true)}
        >
          <Icon name="Edit" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Discard comment"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => void onDelete()}
        >
          <Icon name="Trash2" className="size-3.5" />
        </button>
      </div>
      <div className="mt-1 pl-6 text-2xs text-muted-foreground">Unsent</div>
    </div>
  );
}
