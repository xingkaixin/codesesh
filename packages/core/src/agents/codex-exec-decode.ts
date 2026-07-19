/**
 * Codex "code mode" exec decoding.
 *
 * Since Codex 0.144.x the agent no longer calls tools directly. Every tool
 * invocation is now a `custom_tool_call` named "exec" whose `input` is a small
 * JS program that calls `tools.<name>({...})` (e.g. `tools.exec_command`,
 * `tools.apply_patch`). This module extracts those inner invocations so the
 * adapter can present each one as the native tool call it used to be.
 *
 * The inner argument objects are JS object literals, not JSON — unquoted keys,
 * single/double/template strings, and shorthand `{patch}` that references a
 * `const patch = "..."` declared earlier. A small tolerant reader handles that
 * subset and resolves string variables; anything it cannot parse degrades to an
 * empty result so the caller can fall back to the raw exec display.
 */

export interface ExecInnerCall {
  name: string;
  args: unknown;
}

const PARSE_FAIL = Symbol("parse-fail");

const EXEC_OUTPUT_ENVELOPE_RE = /^Script completed\nWall time [^\n]*\nOutput:\n?/;

/** Strip the `Script completed / Wall time / Output:` wrapper code-mode adds. */
export function stripExecOutputEnvelope(text: string): string {
  return text.replace(EXEC_OUTPUT_ENVELOPE_RE, "");
}

/**
 * Split an inner tool name into `resolveToolIdentity(name, namespace)` inputs.
 * `mcp__node_repl__js` → { name: "js", namespace: "mcp__node_repl__" }.
 */
export function splitExecToolName(name: string): { name: string; namespace?: string } {
  if (name.startsWith("mcp__")) {
    const separator = name.lastIndexOf("__");
    if (separator > 0 && separator + 2 < name.length) {
      return { name: name.slice(separator + 2), namespace: name.slice(0, separator + 2) };
    }
  }
  return { name };
}

/** Extract the patch text from an `apply_patch` argument (`{patch}` or a string). */
export function getExecPatchText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    const patch = (args as Record<string, unknown>)["patch"];
    if (typeof patch === "string") return patch;
  }
  return "";
}

/** Decode the `tools.<name>({...})` invocations inside a code-mode exec program. */
export function decodeExecCalls(input: unknown): ExecInnerCall[] {
  if (typeof input !== "string" || !input.includes("tools.")) return [];

  const scope = collectStringVars(input);
  const calls: ExecInnerCall[] = [];
  const callRe = /tools\.([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(input)) !== null) {
    const reader = new JsValueReader(input, callRe.lastIndex, scope);
    const args = reader.parseValue();
    if (args !== PARSE_FAIL) {
      calls.push({ name: match[1]!, args });
      callRe.lastIndex = reader.pos;
    }
  }
  return calls;
}

/** Pre-scan `const/let/var NAME = "..."` so shorthand args can resolve them. */
function collectStringVars(input: string): Map<string, unknown> {
  const scope = new Map<string, unknown>();
  const assignRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let match: RegExpExecArray | null;
  while ((match = assignRe.exec(input)) !== null) {
    const reader = new JsValueReader(input, assignRe.lastIndex, scope);
    const value = reader.parseValue();
    if (value !== PARSE_FAIL) {
      if (typeof value === "string") scope.set(match[1]!, value);
      assignRe.lastIndex = reader.pos;
    }
  }
  return scope;
}

const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_PART_RE = /[\w$]/;

/** Recursive-descent reader for the JS-literal subset used in exec args. */
class JsValueReader {
  pos: number;
  private readonly src: string;
  private readonly scope: Map<string, unknown>;

  constructor(src: string, start: number, scope: Map<string, unknown>) {
    this.src = src;
    this.pos = start;
    this.scope = scope;
  }

  parseValue(): unknown | typeof PARSE_FAIL {
    this.skipTrivia();
    const char = this.src[this.pos];
    if (char === undefined) return PARSE_FAIL;
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'" || char === "`") return this.parseString(char);
    if (char === "-" || char === "+" || (char >= "0" && char <= "9")) return this.parseNumber();
    if (IDENT_START_RE.test(char)) return this.parseIdentifierValue();
    return PARSE_FAIL;
  }

  private parseObject(): unknown | typeof PARSE_FAIL {
    this.pos++; // {
    const result: Record<string, unknown> = {};
    this.skipTrivia();
    if (this.src[this.pos] === "}") {
      this.pos++;
      return result;
    }
    while (this.pos < this.src.length) {
      this.skipTrivia();
      const key = this.parseKey();
      if (key === PARSE_FAIL) return PARSE_FAIL;
      this.skipTrivia();
      if (this.src[this.pos] === ":") {
        this.pos++;
        const value = this.parseValue();
        if (value === PARSE_FAIL) return PARSE_FAIL;
        result[key] = value;
      } else {
        result[key] = this.resolveIdentifier(key);
      }
      this.skipTrivia();
      const next = this.src[this.pos];
      if (next === ",") {
        this.pos++;
        this.skipTrivia();
        if (this.src[this.pos] === "}") {
          this.pos++;
          return result;
        }
        continue;
      }
      if (next === "}") {
        this.pos++;
        return result;
      }
      return PARSE_FAIL;
    }
    return PARSE_FAIL;
  }

  private parseArray(): unknown | typeof PARSE_FAIL {
    this.pos++; // [
    const result: unknown[] = [];
    this.skipTrivia();
    if (this.src[this.pos] === "]") {
      this.pos++;
      return result;
    }
    while (this.pos < this.src.length) {
      const value = this.parseValue();
      if (value === PARSE_FAIL) return PARSE_FAIL;
      result.push(value);
      this.skipTrivia();
      const next = this.src[this.pos];
      if (next === ",") {
        this.pos++;
        this.skipTrivia();
        if (this.src[this.pos] === "]") {
          this.pos++;
          return result;
        }
        continue;
      }
      if (next === "]") {
        this.pos++;
        return result;
      }
      return PARSE_FAIL;
    }
    return PARSE_FAIL;
  }

  private parseKey(): string | typeof PARSE_FAIL {
    const char = this.src[this.pos];
    if (char === '"' || char === "'" || char === "`") {
      const value = this.parseString(char);
      return typeof value === "string" ? value : PARSE_FAIL;
    }
    if (char !== undefined && IDENT_START_RE.test(char)) return this.readIdentifier();
    return PARSE_FAIL;
  }

  private parseString(quote: string): string {
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.src.length) {
      const char = this.src[this.pos++]!;
      if (char === "\\") {
        out += this.readEscape();
        continue;
      }
      if (char === quote) break;
      out += char;
    }
    return out;
  }

  private readEscape(): string {
    const char = this.src[this.pos++];
    switch (char) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "u": {
        const hex = this.src.slice(this.pos, this.pos + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.pos += 4;
          return String.fromCharCode(parseInt(hex, 16));
        }
        return "u";
      }
      case "x": {
        const hex = this.src.slice(this.pos, this.pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.pos += 2;
          return String.fromCharCode(parseInt(hex, 16));
        }
        return "x";
      }
      default:
        return char ?? "";
    }
  }

  private parseNumber(): number | typeof PARSE_FAIL {
    const numberRe = /[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
    numberRe.lastIndex = this.pos;
    const match = numberRe.exec(this.src);
    if (!match) return PARSE_FAIL;
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private parseIdentifierValue(): unknown {
    const name = this.readIdentifier();
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    if (name === "undefined") return undefined;
    return this.resolveIdentifier(name);
  }

  private resolveIdentifier(name: string): unknown {
    return this.scope.has(name) ? this.scope.get(name) : undefined;
  }

  private readIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.src.length && IDENT_PART_RE.test(this.src[this.pos]!)) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private skipTrivia(): void {
    while (this.pos < this.src.length) {
      const char = this.src[this.pos]!;
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.pos++;
        continue;
      }
      if (char === "/" && this.src[this.pos + 1] === "/") {
        const newline = this.src.indexOf("\n", this.pos + 2);
        this.pos = newline === -1 ? this.src.length : newline + 1;
        continue;
      }
      if (char === "/" && this.src[this.pos + 1] === "*") {
        const close = this.src.indexOf("*/", this.pos + 2);
        this.pos = close === -1 ? this.src.length : close + 2;
        continue;
      }
      break;
    }
  }
}
