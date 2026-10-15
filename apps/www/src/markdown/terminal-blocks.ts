import { CheckIcon, CopyIcon } from "@hugeicons/core-free-icons";
import { guideCopy } from "../data/guides";
import { copy, type Locale } from "../data/landing";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
  data?: { meta?: string | null };
}

interface VisitContext {
  data: { astro?: { frontmatter?: { locale?: Locale } } };
  textContent(node: HastNode): string;
}

const el = (
  tagName: string,
  properties: Record<string, unknown> = {},
  children: HastNode[] = [],
): HastNode => ({ type: "element", tagName, properties, children });
const text = (value: string): HastNode => ({ type: "text", value });

const svg = (icon: typeof CopyIcon) =>
  el(
    "svg",
    { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none", ariaHidden: "true" },
    icon.map(([tag, attrs]) =>
      el(tag, Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== "key"))),
    ),
  );

const withPlaceholders = (line: string) =>
  line
    .split(/(<[a-z][a-z-]*>)/)
    .filter(Boolean)
    .map((part) =>
      /^<[a-z][a-z-]*>$/.test(part) ? el("span", { className: ["ph"] }, [text(part)]) : text(part),
    );

function terminalBlock(source: string, meta: string | null | undefined, locale: Locale) {
  const title = meta?.match(/title="([^"]+)"/)?.[1] ?? guideCopy[locale].terminal;
  const labels = copy[locale].hero;
  const lines: HastNode[] = [];
  let continued = false;
  source.split("\n").forEach((line, index) => {
    if (index) lines.push(text("\n"));
    // A shell line ending in a backslash continues the previous command, so it gets no prompt.
    lines.push(
      el("span", { className: continued ? ["ln"] : ["ln", "cmd"] }, withPlaceholders(line)),
    );
    continued = line.endsWith("\\");
  });

  return el("div", { className: ["code"] }, [
    el("div", { className: ["code-h"] }, [
      el("span", {}, [text(title)]),
      el(
        "button",
        {
          type: "button",
          className: ["term-cp"],
          dataCopyValue: source,
          dataCopyLabel: labels.copyCommand,
          dataCopiedLabel: labels.copied,
          dataCopyFailedLabel: labels.copyFailed,
        },
        [
          el("span", { className: ["copy-icon-stack"] }, [
            el("span", { dataCopyIcon: "idle", dataActive: "true" }, [svg(CopyIcon)]),
            el("span", { dataCopyIcon: "done" }, [svg(CheckIcon)]),
          ]),
          el("span", { dataCopyText: "" }, [text(labels.copyCommand)]),
        ],
      ),
    ]),
    el("pre", { tabIndex: 0 }, [el("code", {}, lines)]),
  ]);
}

export const terminalBlocks = {
  name: "terminal-blocks",
  element: {
    filter: ["pre"],
    visit(node: HastNode, ctx: VisitContext) {
      const code = node.children?.find((child) => child.tagName === "code");
      if (!code) return;
      const locale = ctx.data.astro?.frontmatter?.locale ?? "en";
      return terminalBlock(ctx.textContent(code).replace(/\n$/, ""), code.data?.meta, locale);
    },
  },
};
