/**
 * Compatibility boundary for the private DOM contract rendered by
 * `@pierre/trees`. Keep selectors, Shadow DOM access, and Base UI trigger
 * bridging here so dependency upgrades have one integration surface to verify.
 */

export const SESSION_TREE_UNSAFE_CSS = `
  [data-item-section='spacing-item'] {
    border-left: none;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='icon'] {
    display: none;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='spacing'] {
    padding-left: 2px;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='spacing'] > [data-item-section='spacing-item'] {
    margin-right: 4px;
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder'] > [data-item-section='spacing'] {
    padding-left: 2px;
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder']
    > [data-item-section='spacing']
    > [data-item-section='spacing-item'] {
    margin-right: 4px;
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder'] > [data-item-section='icon'] {
    flex: 0 0 8px;
    width: 8px;
    margin-left: calc(-1 * (8px + var(--trees-item-row-gap)));
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder']
    > [data-item-section='icon']
    > svg {
    width: 8px;
    height: 8px;
  }

  [data-type='item'] > [data-item-section='content'] {
    flex: 1 1 auto;
  }

  [data-type='item'] > [data-item-section='content'] {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: ltr;
  }

  [data-type='item'] > [data-item-section='decoration'] {
    flex: 0 0 auto;
    padding-inline: 6px 2px;
  }

  [data-type='item'] > [data-item-section='decoration']:has(> span[title='Session options']) {
    flex-basis: 24px;
    padding-inline: 0;
  }

  [data-type='item'] > [data-item-section='decoration'] > span[title='Session options'] {
    box-sizing: border-box;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 12px;
    line-height: 24px;
    transition:
      color var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
  }

  [data-type='item'] > [data-item-section='decoration'] > span[title='Session options']:hover {
    color: var(--console-text);
    background-color: var(--console-surface-muted);
    border-color: var(--console-border);
  }

  [data-type='item'] > [data-item-section='decoration'] > span[title='Session options']:active {
    transform: scale(0.97);
  }

  [data-type='item'] [data-truncate-group-container='middle'] {
    display: inline;
    min-width: 0;
    white-space: nowrap;
  }

  [data-type='item'] [data-truncate-group-container='middle'] > div {
    display: inline;
    min-width: 0;
  }

  [data-type='item'] [data-truncate-container] {
    display: inline;
    height: auto;
    margin: 0;
    overflow: visible;
  }

  [data-type='item'] [data-truncate-grid] {
    display: inline;
    position: static;
  }

  [data-type='item'] [data-truncate-grid] > div:not([data-truncate-marker-cell]) {
    display: inline;
  }

  [data-type='item'] [data-truncate-content='visible'] {
    display: inline;
    white-space: nowrap;
    direction: ltr;
  }

  [data-type='item'] [data-truncate-content='overflow'],
  [data-type='item'] [data-truncate-fill],
  [data-type='item'] [data-truncate-marker-cell],
  [data-type='item'] [data-truncate-marker] {
    display: none;
  }

  [data-type='item'] [data-session-title-scroll='running'],
  [data-type='item'] [data-session-title-scroll-complete] {
    text-overflow: clip;
  }
`;

export interface SessionTreeMenuTarget {
  item: HTMLElement;
  anchor: HTMLElement;
  path: string;
}

const SESSION_TITLE_SCROLL_SPEED_PX_PER_MS = 0.08;
const SESSION_TITLE_SCROLL_GAP_PX = 16;
const SESSION_TITLE_SCROLL_MIN_DURATION_MS = 700;
const SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE = 1 / 3;
const SESSION_TITLE_SCROLL_DURATION_MULTIPLIER = 1 + SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE;
const SESSION_TITLE_SCROLL_SLOWDOWN_START =
  (1 - SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE) / SESSION_TITLE_SCROLL_DURATION_MULTIPLIER;

export function getSessionTreeMenuTarget(
  event: Event,
  options: { requireDecoration: boolean },
): SessionTreeMenuTarget | null {
  const path = event.composedPath();
  const decoration = path.find(
    (target): target is HTMLElement =>
      target instanceof HTMLElement &&
      target.parentElement?.getAttribute("data-item-section") === "decoration",
  );
  if (options.requireDecoration && !decoration) return null;

  const item = path.find(
    (target): target is HTMLElement =>
      target instanceof HTMLElement && target.getAttribute("data-type") === "item",
  );
  if (!item) return null;

  const itemPath = item.getAttribute("data-item-path");
  if (!itemPath) return null;
  const anchor =
    decoration ??
    item.querySelector<HTMLElement>("[data-item-section='decoration'] > span") ??
    item;
  return { item, anchor, path: itemPath };
}

export function openSessionTreeMenu(proxyTrigger: HTMLElement | null): void {
  proxyTrigger?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
  );
}

export function installSessionTreeDomAdapter(host: HTMLElement): () => void {
  const root = host.shadowRoot;
  if (!root) return () => {};

  const activeElements = new Set<HTMLElement>();
  const preparedElements = new Set<HTMLElement>();
  const frameByElement = new WeakMap<HTMLElement, number>();
  const copyByElement = new WeakMap<HTMLElement, HTMLElement>();

  function reset(element: HTMLElement) {
    const frame = frameByElement.get(element);
    if (frame !== undefined) cancelAnimationFrame(frame);
    copyByElement.get(element)?.remove();
    copyByElement.delete(element);
    preparedElements.delete(element);
    frameByElement.delete(element);
    activeElements.delete(element);
    element.scrollLeft = 0;
    element.removeAttribute("data-session-title-scroll");
    element.removeAttribute("data-session-title-scroll-complete");
  }

  function start(element: HTMLElement) {
    if (isReducedMotionPreferred() || element.hasAttribute("data-session-title-scroll-complete")) {
      return;
    }

    reset(element);
    const track = element.querySelector<HTMLElement>('[data-truncate-group-container="middle"]');
    const trackWidth = track?.getBoundingClientRect().width ?? 0;
    if (!track || trackWidth <= element.clientWidth + 1) return;

    const copy = track.cloneNode(true) as HTMLElement;
    copy.dataset.sessionTitleScrollCopy = "true";
    copy.setAttribute("aria-hidden", "true");
    copy.style.marginInlineStart = `${SESSION_TITLE_SCROLL_GAP_PX}px`;
    element.append(copy);
    copyByElement.set(element, copy);
    preparedElements.add(element);
    element.setAttribute("data-session-title-scroll", "running");

    const scrollDistance = trackWidth + SESSION_TITLE_SCROLL_GAP_PX;
    const forwardDuration = Math.max(
      SESSION_TITLE_SCROLL_MIN_DURATION_MS,
      (scrollDistance / SESSION_TITLE_SCROLL_SPEED_PX_PER_MS) *
        SESSION_TITLE_SCROLL_DURATION_MULTIPLIER,
    );
    const startedAt = performance.now();
    activeElements.add(element);

    const step = (now: number) => {
      if (!activeElements.has(element)) return;

      const progress = Math.min(1, Math.max(0, (now - startedAt) / forwardDuration));
      element.scrollLeft = scrollDistance * easeSessionTitleScrollToStop(progress);

      if (progress >= 1) {
        activeElements.delete(element);
        frameByElement.delete(element);
        element.removeAttribute("data-session-title-scroll");
        element.setAttribute("data-session-title-scroll-complete", "true");
        return;
      }

      frameByElement.set(element, requestAnimationFrame(step));
    };

    frameByElement.set(element, requestAnimationFrame(step));
  }

  function handlePointerOver(event: Event) {
    const element = getSessionTitleContent(event.target);
    const relatedTarget = (event as PointerEvent).relatedTarget;
    if (!element || (relatedTarget instanceof Node && element.contains(relatedTarget))) return;
    start(element);
  }

  function handlePointerOut(event: Event) {
    const element = getSessionTitleContent(event.target);
    const relatedTarget = (event as PointerEvent).relatedTarget;
    if (!element || (relatedTarget instanceof Node && element.contains(relatedTarget))) return;
    reset(element);
  }

  root.addEventListener("pointerover", handlePointerOver);
  root.addEventListener("pointerout", handlePointerOut);

  return () => {
    root.removeEventListener("pointerover", handlePointerOver);
    root.removeEventListener("pointerout", handlePointerOut);
    for (const element of preparedElements) reset(element);
  };
}

function getSessionTitleContent(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const content = target.closest<HTMLElement>('[data-item-section="content"]');
  if (!content || content.parentElement?.getAttribute("data-type") !== "item") return null;
  return content;
}

function isReducedMotionPreferred() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function easeSessionTitleScrollToStop(progress: number) {
  if (progress <= SESSION_TITLE_SCROLL_SLOWDOWN_START) {
    return (
      (progress / SESSION_TITLE_SCROLL_SLOWDOWN_START) *
      (1 - SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE)
    );
  }

  const slowdownProgress =
    (progress - SESSION_TITLE_SCROLL_SLOWDOWN_START) / (1 - SESSION_TITLE_SCROLL_SLOWDOWN_START);
  const slowdownPosition = slowdownProgress * (2 - slowdownProgress);
  return (
    1 -
    SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE +
    SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE * slowdownPosition
  );
}
