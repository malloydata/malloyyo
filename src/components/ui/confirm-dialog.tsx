// Copyright (c) The Malloy Foundation
// SPDX-License-Identifier: MIT

"use client";

// A button that asks before acting, composed from the shadcn dialog parts
// (./dialog — house-skinned). Kept separate from the generated file so
// `shadcn add dialog --overwrite` never eats it.
//
// The confirm action is an async boolean: the dialog closes when it resolves
// true and stays open (with the caller's error surfaced wherever the caller
// shows errors) when it resolves false.

import { useState, type ReactNode } from "react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = false,
}: {
  /** The button that opens the dialog, e.g. a styled "Disable". */
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<boolean>;
  /** Styles the confirm button for an action that takes something away. */
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    const ok = await onConfirm();
    setBusy(false);
    if (ok) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <button
              type="button"
              disabled={busy}
              className="rounded border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-xs hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-40"
            >
              Cancel
            </button>
          </DialogClose>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={busy}
            className={
              destructive
                ? "rounded bg-red-600 text-white px-3 py-1.5 text-xs hover:bg-red-700 disabled:opacity-40"
                : "rounded bg-black text-white dark:bg-white dark:text-black px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-40"
            }
          >
            {busy ? "…" : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
