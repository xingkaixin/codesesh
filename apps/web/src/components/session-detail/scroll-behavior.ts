export type SessionAnchorScrollBehavior = "auto" | "smooth";

export type ScrollParent = HTMLElement | Window;

export type SessionAnchorScrollHandler = (
  anchorId: string,
  behavior: SessionAnchorScrollBehavior,
) => void;

export function getActivationScrollBehavior(eventDetail: number): SessionAnchorScrollBehavior {
  return eventDetail === 0 ? "auto" : "smooth";
}

export function resolveReducedMotionScrollBehavior(
  behavior: SessionAnchorScrollBehavior,
  prefersReducedMotion: boolean,
): SessionAnchorScrollBehavior {
  return behavior === "smooth" && prefersReducedMotion ? "auto" : behavior;
}

export function findScrollParent(node: HTMLElement): ScrollParent {
  let parent = node.parentElement;

  while (parent) {
    const { overflowY } = window.getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return parent;
    parent = parent.parentElement;
  }

  return window;
}

export function isWindowScrollParent(parent: ScrollParent): parent is Window {
  return parent === window;
}

export function getScrollTop(parent: ScrollParent) {
  if (!isWindowScrollParent(parent)) return parent.scrollTop;
  return window.scrollY || (document.scrollingElement ?? document.documentElement).scrollTop;
}

export function getViewportHeight(parent: ScrollParent) {
  return isWindowScrollParent(parent) ? window.innerHeight || 900 : parent.clientHeight;
}

export function getScrollHeight(parent: ScrollParent) {
  return isWindowScrollParent(parent)
    ? (document.scrollingElement ?? document.documentElement).scrollHeight
    : parent.scrollHeight;
}

export function getElementTop(parent: ScrollParent, element: HTMLElement) {
  if (isWindowScrollParent(parent))
    return element.getBoundingClientRect().top + getScrollTop(parent);

  const parentRect = parent.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return parent.scrollTop + elementRect.top - parentRect.top;
}

export function scrollParentTo(parent: ScrollParent, top: number) {
  if (isWindowScrollParent(parent)) {
    window.scrollTo({ top, behavior: "auto" });
    return;
  }

  parent.scrollTo({ top, behavior: "auto" });
}
