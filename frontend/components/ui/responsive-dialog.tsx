"use client";

/**
 * A dialog on desktop, a bottom sheet on a phone.
 *
 * A centred modal on a phone puts its buttons in the middle of the screen,
 * out of thumb reach, and fights the on-screen keyboard. A bottom sheet sits
 * where the thumb already is, can be dragged away, and scrolls with the
 * keyboard. Same content, same props — the component picks the container.
 */
import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { useIsDesktop } from "@/lib/use-device";
import { cn } from "@/lib/utils";

export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={cn("gap-0 overflow-hidden p-0 sm:max-w-lg", className)}>
          <DialogHeader className="border-b px-6 py-5 text-left">
            <div className="flex items-center gap-3">
              {icon && (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  {icon}
                </div>
              )}
              <div>
                <DialogTitle className="text-base">{title}</DialogTitle>
                {description && (
                  <DialogDescription className="mt-0.5 text-xs">{description}</DialogDescription>
                )}
              </div>
            </div>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
          {footer && <DialogFooter className="border-t bg-muted/30 px-6 py-4">{footer}</DialogFooter>}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className={cn("max-h-[92dvh] rounded-t-3xl", className)}>
        <DrawerHeader className="px-5 pb-2 pt-3 text-left!">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                {icon}
              </div>
            )}
            <div>
              <DrawerTitle className="text-lg">{title}</DrawerTitle>
              {description && (
                <DrawerDescription className="mt-0.5 text-sm">{description}</DrawerDescription>
              )}
            </div>
          </div>
        </DrawerHeader>
        <div className="overflow-y-auto px-5 py-3">{children}</div>
        {footer && (
          <DrawerFooter className="pb-safe border-t px-5 pt-4">
            <div className="flex flex-col-reverse gap-2 [&>*]:h-12 [&>*]:w-full [&>*]:text-base">
              {footer}
            </div>
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
}
