import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent as ReactFocusEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type OpenFocusTarget = "menu" | "first" | "last";

interface PopupMenuContextValue {
  open: boolean;
  setOpen: (next: boolean, focusTarget?: OpenFocusTarget) => void;
  openFocusTargetRef: RefObject<OpenFocusTarget>;
  triggerEl: HTMLElement | null;
  setTriggerEl: (el: HTMLElement | null) => void;
  popupEl: HTMLDivElement | null;
  setPopupEl: (el: HTMLDivElement | null) => void;
  finalFocusRef: RefObject<RefObject<HTMLElement | null> | undefined>;
  closeAndRestoreFocus: () => void;
}

const PopupMenuContext = createContext<PopupMenuContextValue | null>(null);

function usePopupMenuContext(): PopupMenuContextValue {
  const ctx = useContext(PopupMenuContext);
  if (!ctx) throw new Error("PopupMenu components must be rendered inside PopupMenu.Root");
  return ctx;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else (ref as { current: T | null }).current = value;
}

function getFocusableMenuItems(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
  ).filter((el) => !el.hasAttribute("disabled"));
}

function Root({
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  children: ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [popupEl, setPopupEl] = useState<HTMLDivElement | null>(null);
  const openFocusTargetRef = useRef<OpenFocusTarget>("menu");
  const finalFocusRef = useRef<RefObject<HTMLElement | null> | undefined>(undefined);
  const open = controlledOpen ?? uncontrolledOpen;

  const setOpen = useCallback(
    (next: boolean, focusTarget: OpenFocusTarget = "menu") => {
      if (next) openFocusTargetRef.current = focusTarget;
      if (controlledOpen === undefined) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange],
  );

  const closeAndRestoreFocus = useCallback(() => {
    const target = finalFocusRef.current?.current ?? triggerEl;
    setOpen(false);
    if (target) {
      queueMicrotask(() => target.focus());
    }
  }, [setOpen, triggerEl]);

  return (
    <PopupMenuContext.Provider
      value={{
        open,
        setOpen,
        openFocusTargetRef,
        triggerEl,
        setTriggerEl,
        popupEl,
        setPopupEl,
        finalFocusRef,
        closeAndRestoreFocus,
      }}
    >
      {children}
    </PopupMenuContext.Provider>
  );
}

function Trigger({
  ref,
  onClick,
  onKeyDown,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  const { open, setOpen, setTriggerEl } = usePopupMenuContext();

  const handleRef = useCallback(
    (node: HTMLButtonElement | null) => {
      setTriggerEl(node);
      assignRef(ref, node);
    },
    [ref, setTriggerEl],
  );

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      setOpen(!open, event.detail === 0 ? "first" : "menu");
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true, "first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true, "last");
    }
  };

  return (
    <button
      type="button"
      {...rest}
      ref={handleRef}
      aria-haspopup="menu"
      aria-expanded={open}
      data-popup-open={open ? "" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
    </button>
  );
}

function Portal({ children }: { children: ReactNode }) {
  const { open } = usePopupMenuContext();
  if (!open || typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

interface PositionerContextValue {
  side: "top" | "bottom";
  align: "start" | "end";
  sideOffset: number;
  anchor?: RefObject<HTMLElement | null>;
  className?: string;
}

const PositionerContext = createContext<PositionerContextValue>({
  side: "bottom",
  align: "start",
  sideOffset: 4,
});

function Positioner({
  side = "bottom",
  align = "start",
  sideOffset = 4,
  anchor,
  className,
  children,
}: {
  side?: "top" | "bottom";
  align?: "start" | "end";
  sideOffset?: number;
  anchor?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PositionerContext.Provider value={{ side, align, sideOffset, anchor, className }}>
      {children}
    </PositionerContext.Provider>
  );
}

function Popup({
  finalFocus,
  className,
  onFocus,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  finalFocus?: RefObject<HTMLElement | null>;
}) {
  const {
    open,
    setOpen,
    openFocusTargetRef,
    triggerEl,
    setPopupEl,
    finalFocusRef,
    closeAndRestoreFocus,
  } = usePopupMenuContext();
  const {
    side,
    align,
    sideOffset,
    anchor,
    className: positionerClass,
  } = useContext(PositionerContext);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const localRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    finalFocusRef.current = finalFocus;
  }, [finalFocus, finalFocusRef]);

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      setPopupEl(node);
    },
    [setPopupEl],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const anchorEl = anchor?.current ?? triggerEl;
    const wrapper = wrapperRef.current;
    const popup = localRef.current;
    if (anchorEl && wrapper && popup) {
      const updatePosition = () => {
        const rect = anchorEl.getBoundingClientRect();
        const popupRect = popup.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const padding = 8;

        let top =
          side === "top" ? rect.top - popupRect.height - sideOffset : rect.bottom + sideOffset;
        if (
          side === "top" &&
          top < padding &&
          rect.bottom + sideOffset + popupRect.height <= vh - padding
        ) {
          top = rect.bottom + sideOffset;
        } else if (
          side === "bottom" &&
          top + popupRect.height > vh - padding &&
          rect.top - popupRect.height - sideOffset >= padding
        ) {
          top = rect.top - popupRect.height - sideOffset;
        }
        top = Math.max(padding, Math.min(top, Math.max(padding, vh - popupRect.height - padding)));

        let left = align === "end" ? rect.right - popupRect.width : rect.left;
        left = Math.max(padding, Math.min(left, Math.max(padding, vw - popupRect.width - padding)));
        wrapper.style.top = `${top}px`;
        wrapper.style.left = `${left}px`;
      };
      updatePosition();
      window.addEventListener("resize", updatePosition);

      const items = getFocusableMenuItems(popup);
      const mode = openFocusTargetRef.current;
      if (mode === "first" && items.length > 0) {
        items[0]!.focus({ preventScroll: true });
      } else if (mode === "last" && items.length > 0) {
        items[items.length - 1]!.focus({ preventScroll: true });
      } else {
        popup.focus({ preventScroll: true });
      }

      return () => window.removeEventListener("resize", updatePosition);
    }
    popup?.focus({ preventScroll: true });
    return undefined;
  }, [open, anchor, triggerEl, side, align, sideOffset, openFocusTargetRef]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (localRef.current?.contains(target)) return;
      const anchorEl = anchor?.current ?? triggerEl;
      if (anchorEl?.contains(target)) return;
      setOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeAndRestoreFocus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [open, anchor, triggerEl, setOpen, closeAndRestoreFocus]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = getFocusableMenuItems(localRef.current);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[currentIndex < 0 ? 0 : (currentIndex + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[
        currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length
      ]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  const handleFocus = (event: ReactFocusEvent<HTMLDivElement>) => {
    onFocus?.(event);
  };

  return (
    <div
      ref={wrapperRef}
      className={positionerClass}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
      }}
    >
      <div
        {...rest}
        ref={handleRef}
        role="menu"
        tabIndex={-1}
        className={className}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

function Item({
  onClick,
  closeOnClick = true,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { closeOnClick?: boolean }) {
  const { closeAndRestoreFocus } = usePopupMenuContext();

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (closeOnClick && !event.defaultPrevented) {
      closeAndRestoreFocus();
    }
  };

  return (
    <button type="button" role="menuitem" {...rest} className={className} onClick={handleClick}>
      {children}
    </button>
  );
}

interface RadioGroupContextValue<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function RadioGroup<T extends string>({
  value,
  onValueChange,
  children,
}: {
  value: T;
  onValueChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <RadioGroupContext.Provider
      value={{
        value,
        onValueChange: onValueChange as (value: string) => void,
      }}
    >
      <div role="group">{children}</div>
    </RadioGroupContext.Provider>
  );
}

function RadioItem<T extends string>({
  value,
  closeOnClick = false,
  onClick,
  className,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> & {
  value: T;
  closeOnClick?: boolean;
}) {
  const { closeAndRestoreFocus } = usePopupMenuContext();
  const group = useContext(RadioGroupContext);
  const checked = group ? group.value === value : false;

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      group?.onValueChange(value);
      if (closeOnClick) closeAndRestoreFocus();
    }
  };

  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      {...rest}
      className={className}
      onClick={handleClick}
    >
      {children}
    </button>
  );
}

function GroupLabel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={className}>
      {children}
    </div>
  );
}

export const Menu = {
  Root,
  Trigger,
  Portal,
  Positioner,
  Popup,
  Item,
  RadioGroup,
  RadioItem,
  GroupLabel,
};
