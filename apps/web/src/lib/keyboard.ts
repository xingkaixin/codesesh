const INTERACTIVE_TAGS = new Set(["a", "button", "summary", "input", "textarea", "select"]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "treeitem",
]);

export function isEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

/**
 * Returns true when the event target (or an ancestor) is a native or ARIA
 * interactive control that handles Enter activation itself.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (isEditableTarget(target)) return true;

  let current: Element | null = target;
  while (current) {
    if (INTERACTIVE_TAGS.has(current.tagName.toLowerCase())) return true;
    const role = current.getAttribute("role");
    if (role) {
      for (const token of role.trim().toLowerCase().split(/\s+/)) {
        if (INTERACTIVE_ROLES.has(token)) return true;
      }
    }
    current = current.parentElement;
  }

  return false;
}
