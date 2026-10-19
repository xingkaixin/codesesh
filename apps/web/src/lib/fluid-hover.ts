export function attachFluidHover(group: HTMLElement) {
  const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const axis = group.dataset.fluidHover ?? "x";
  let frame = 0;
  let dirty = true;
  let active: HTMLElement | undefined;
  let point = { x: 0, y: 0 };
  let origin = { left: 0, top: 0, scaleX: 1, scaleY: 1 };
  let items: { element: HTMLElement; rect: DOMRect }[] = [];

  function hide() {
    cancelAnimationFrame(frame);
    frame = 0;
    active?.removeAttribute("data-fluid-active");
    active = undefined;
    delete group.dataset.fluidVisible;
    delete group.dataset.fluidTravel;
  }

  function invalidate() {
    dirty = true;
    hide();
  }

  function render() {
    frame = 0;
    if (dirty) {
      const rect = group.getBoundingClientRect();
      origin = {
        left: rect.left,
        top: rect.top,
        scaleX: rect.width / (group.offsetWidth || 1),
        scaleY: rect.height / (group.offsetHeight || 1),
      };
      items = Array.from(group.querySelectorAll<HTMLElement>("[data-fluid-item]"))
        .filter((element) => !element.matches(":disabled, [aria-disabled='true']"))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);
      dirty = false;
    }
    let closest: (typeof items)[number] | undefined;
    let distance = Infinity;
    const left = Math.min(...items.map(({ rect }) => rect.left));
    const right = Math.max(...items.map(({ rect }) => rect.right));
    const top = Math.min(...items.map(({ rect }) => rect.top));
    const bottom = Math.max(...items.map(({ rect }) => rect.bottom));
    if (point.x < left || point.x > right || point.y < top || point.y > bottom) {
      hide();
      return;
    }
    for (const item of items) {
      const { rect } = item;
      const inside =
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom;
      const delta = inside
        ? -1
        : Math.abs(
            axis === "y"
              ? point.y - (rect.top + rect.height / 2)
              : point.x - (rect.left + rect.width / 2),
          );
      if (delta < distance) {
        closest = item;
        distance = delta;
      }
    }
    if (!closest || closest.element === active) return;
    if (active) group.dataset.fluidTravel = "";
    active?.removeAttribute("data-fluid-active");
    active = closest.element;
    active.dataset.fluidActive = "";
    const { rect } = closest;
    group.style.setProperty(
      "--fluid-x",
      `${(rect.left - origin.left) / origin.scaleX - group.clientLeft + group.scrollLeft}px`,
    );
    group.style.setProperty(
      "--fluid-y",
      `${(rect.top - origin.top) / origin.scaleY - group.clientTop + group.scrollTop}px`,
    );
    group.style.setProperty("--fluid-width", `${rect.width / origin.scaleX}px`);
    group.style.setProperty("--fluid-height", `${rect.height / origin.scaleY}px`);
    group.dataset.fluidVisible = "";
  }

  function move(event: PointerEvent) {
    if (!pointer.matches || event.pointerType !== "mouse") return;
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest("a, button, input, select, textarea");
    if (control && !control.matches("[data-fluid-item]")) {
      hide();
      return;
    }
    point = { x: event.clientX, y: event.clientY };
    if (!frame) frame = requestAnimationFrame(render);
  }

  function enter(event: PointerEvent) {
    dirty = true;
    move(event);
  }

  const resize = new ResizeObserver(invalidate);
  function observeItems() {
    resize.disconnect();
    resize.observe(group);
    group
      .querySelectorAll<HTMLElement>("[data-fluid-item]")
      .forEach((item) => resize.observe(item));
    invalidate();
  }
  const mutation = new MutationObserver(observeItems);
  observeItems();
  mutation.observe(group, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled", "hidden"],
  });
  group.dataset.fluidReady = "";
  group.addEventListener("pointerenter", enter);
  group.addEventListener("pointermove", move);
  group.addEventListener("pointerleave", hide);
  group.addEventListener("pointercancel", hide);
  group.addEventListener("keydown", hide);
  window.addEventListener("scroll", invalidate, true);
  window.addEventListener("resize", invalidate);
  pointer.addEventListener("change", invalidate);

  return () => {
    hide();
    resize.disconnect();
    mutation.disconnect();
    group.removeEventListener("pointerenter", enter);
    group.removeEventListener("pointermove", move);
    group.removeEventListener("pointerleave", hide);
    group.removeEventListener("pointercancel", hide);
    group.removeEventListener("keydown", hide);
    window.removeEventListener("scroll", invalidate, true);
    window.removeEventListener("resize", invalidate);
    pointer.removeEventListener("change", invalidate);
    delete group.dataset.fluidReady;
    for (const name of ["x", "y", "width", "height"]) group.style.removeProperty(`--fluid-${name}`);
  };
}
