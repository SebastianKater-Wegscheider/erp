import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "../../lib/utils";

let lastSelectTriggerEl: HTMLElement | null = null;
let lastSelectScrollSnapshot: SelectScrollSnapshot | null = null;

type SelectScrollSnapshot = {
  windowX: number;
  windowY: number;
  container: HTMLElement | null;
  containerLeft: number;
  containerTop: number;
};

function hasScrollableOverflow(value: string): boolean {
  return value.includes("auto") || value.includes("scroll") || value.includes("overlay");
}

function findScrollableAncestor(element: HTMLElement | null): HTMLElement | null {
  let current = element?.parentElement ?? null;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const scrollableY = hasScrollableOverflow(style.overflowY) && current.scrollHeight > current.clientHeight;
    const scrollableX = hasScrollableOverflow(style.overflowX) && current.scrollWidth > current.clientWidth;
    if (scrollableX || scrollableY) return current;
    current = current.parentElement;
  }
  return null;
}

function captureScrollSnapshot(trigger: HTMLElement): SelectScrollSnapshot {
  const container = findScrollableAncestor(trigger);
  return {
    windowX: window.scrollX,
    windowY: window.scrollY,
    container,
    containerLeft: container?.scrollLeft ?? 0,
    containerTop: container?.scrollTop ?? 0,
  };
}

function restoreScrollSnapshot(snapshot: SelectScrollSnapshot | null): void {
  if (!snapshot) return;
  requestAnimationFrame(() => {
    if (snapshot.container && snapshot.container.isConnected) {
      snapshot.container.scrollTo(snapshot.containerLeft, snapshot.containerTop);
    }
    window.scrollTo(snapshot.windowX, snapshot.windowY);
  });
}

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, onPointerDown, onKeyDown, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      // Mobile: >=16px font-size to avoid iOS Safari zoom; slightly taller tap target.
      "flex h-10 w-full items-center justify-between rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] px-3 py-2 text-[16px] text-[color:var(--app-text)] shadow-[inset_0_1px_0_color-mix(in_oklab,var(--app-border)_30%,transparent),0_6px_16px_-14px_color-mix(in_oklab,var(--app-primary)_42%,transparent)] focus:outline-none focus:ring-2 focus:ring-[color:color-mix(in_oklab,var(--app-primary)_34%,transparent)] focus:ring-offset-2 focus:ring-offset-[color:var(--app-bg)] disabled:cursor-not-allowed disabled:opacity-50 sm:h-9 sm:text-sm",
      className,
    )}
    onPointerDown={(event) => {
      lastSelectTriggerEl = event.currentTarget;
      lastSelectScrollSnapshot = captureScrollSnapshot(event.currentTarget);
      onPointerDown?.(event);
    }}
    onKeyDown={(event) => {
      // Capture for keyboard-opened selects as well.
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown" || event.key === "ArrowUp") {
        lastSelectTriggerEl = event.currentTarget;
        lastSelectScrollSnapshot = captureScrollSnapshot(event.currentTarget);
      }
      onKeyDown?.(event);
    }}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", onCloseAutoFocus, ...props }, ref) => {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        {...props}
        className={cn(
          "relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-lg border border-[color:var(--app-border)] bg-[color:var(--app-surface-elevated)] text-[color:var(--app-text)] shadow-[0_16px_36px_-24px_color-mix(in_oklab,var(--app-primary)_72%,transparent)]",
          className,
        )}
        position={position}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;

          // Prevent Radix from restoring focus in a way that can scroll the viewport.
          event.preventDefault();

          const el = lastSelectTriggerEl;
          const scrollSnapshot = lastSelectScrollSnapshot;
          if (!el) return;
          lastSelectTriggerEl = null;
          lastSelectScrollSnapshot = null;
          try {
            el.focus({ preventScroll: true });
          } catch {
            el.focus();
          }

          // Restore both viewport and nearest scroll container to avoid jump-to-top in long forms/dialogs.
          restoreScrollSnapshot(scrollSnapshot);
        }}
      >
        <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
          <ChevronUp className="h-4 w-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1">
          <ChevronDown className="h-4 w-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex w-full cursor-default select-none items-center rounded-md py-2 pl-8 pr-2 text-[16px] outline-none focus:bg-[color:var(--app-primary-soft)] focus:text-[color:var(--app-primary-strong)] data-[disabled]:pointer-events-none data-[disabled]:opacity-50 sm:py-1.5 sm:text-sm",
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectItem,
};

export const __selectTestUtils = {
  findScrollableAncestor,
  captureScrollSnapshot,
  restoreScrollSnapshot,
};
