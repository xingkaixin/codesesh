import { describe, expect, it } from "vitest";
import { isEditableTarget, isInteractiveTarget } from "./keyboard";

describe("keyboard target guards", () => {
  it("recognizes native interactive elements and their descendants", () => {
    for (const tag of ["button", "a", "summary", "input", "textarea", "select"]) {
      const element = document.createElement(tag);
      const child = document.createElement("span");
      element.appendChild(child);

      expect(isInteractiveTarget(element)).toBe(true);
      expect(isInteractiveTarget(child)).toBe(true);
    }
  });

  it("recognizes interactive ARIA widget roles and their descendants", () => {
    for (const role of [
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
    ]) {
      const widget = document.createElement("div");
      widget.setAttribute("role", role);
      const label = document.createElement("span");
      widget.appendChild(label);

      expect(isInteractiveTarget(widget)).toBe(true);
      expect(isInteractiveTarget(label)).toBe(true);
    }
  });

  it("allows non-interactive elements and non-element targets", () => {
    const container = document.createElement("div");
    const region = document.createElement("section");
    region.setAttribute("role", "region");
    container.appendChild(region);

    expect(isInteractiveTarget(container)).toBe(false);
    expect(isInteractiveTarget(region)).toBe(false);
    expect(isInteractiveTarget(document.body)).toBe(false);
    expect(isInteractiveTarget(window)).toBe(false);
    expect(isInteractiveTarget(null)).toBe(false);
  });

  it("distinguishes editable targets from button/link controls", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    const link = document.createElement("a");

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(button)).toBe(false);
    expect(isEditableTarget(link)).toBe(false);
  });
});
