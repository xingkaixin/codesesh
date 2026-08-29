import { createHmac, type BinaryLike } from "node:crypto";
import { homedir } from "node:os";
import { types } from "node:util";
import { AGENT_CATALOG } from "@codesesh/core/contract";
import type { WorkerLogContext, WorkerLogLevel } from "@codesesh/core/runtime/diagnostics";

export const LOG_SCHEMA_VERSION = 1;
export const MIN_LOG_RECORD_BYTES = 512;

const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_FIELDS = 100;
const MAX_DEPTH = 5;
const MAX_STRING_LENGTH = 4_000;
const MAX_SANITIZED_VALUES = 1_000;
const REDACTED_VALUE = "[redacted]";
const OMITTED_VALUE = "[omitted]";
const TRUNCATED_VALUE = "[truncated]";
const UNSERIALIZABLE_VALUE = "[unserializable]";
const ACCESSOR_VALUE = "[accessor]";
const CIRCULAR_VALUE = "[circular]";
const SAFE_SENTINELS = new Set([
  ACCESSOR_VALUE,
  CIRCULAR_VALUE,
  OMITTED_VALUE,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  UNSERIALIZABLE_VALUE,
]);
const LOG_CONTEXT_KEYS = new Set<keyof WorkerLogContext>([
  "request_id",
  "operation_id",
  "publication_id",
]);
const CORRELATION_ID_KEYS = new Set([...LOG_CONTEXT_KEYS, "connection_id"]);

const SENSITIVE_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "cookie",
  "credential",
  "credentials",
  "id_token",
  "passphrase",
  "passwd",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "set_cookie",
  "token",
]);

const OMITTED_KEYS = new Set([
  "argv",
  "body",
  "command_args",
  "content",
  "env",
  "environment",
  "headers",
  "http_body",
  "message",
  "messages",
  "prompt",
  "prompts",
  "request_body",
  "response_body",
  "stderr",
  "stdout",
  "tool_output",
  "tool_outputs",
  "transcript",
  "transcripts",
]);

const IDENTIFIER_KEYS = new Set([
  "cursor",
  "message_cursor",
  "request_key",
  "session",
  "session_id",
]);
const ERROR_TEXT_KEYS = new Set(["cause", "error"]);
const KNOWN_AGENT_NAMES = new Set<string>(AGENT_CATALOG.map(({ name }) => name));
const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const AUDITED_STRING_VALUES = new Map<string, ReadonlySet<string>>([
  [
    "mode",
    new Set([
      "agent",
      "bulk",
      "incremental",
      "invalidRoute",
      "missingAgent",
      "project",
      "projects",
      "root",
      "session",
    ]),
  ],
  ["phase", new Set(["measure", "mount", "nested-update", "update"])],
  [
    "profiler_id",
    new Set([
      "App",
      "InteractiveReceipt",
      "MainContent",
      "MessageList",
      "OverviewScreen",
      "SearchControls",
      "SearchResultsPanel",
      "SessionDetail",
      "SessionTreeSidebar",
    ]),
  ],
  ["source", new Set(["commit-latency", "custom-timing", "react-profiler"])],
  ["trigger", new Set(["route"])],
  ["reason", new Set(["query-cancelled"])],
  ["exception_origin", new Set(["uncaughtException", "unhandledRejection"])],
]);
const INTERNAL_PLAINTEXT_KEYS = new Set([
  "authentication",
  "bind_category",
  "cache",
  "close_reason",
  "context",
  "encoding",
  "endpoint",
  "event",
  "exception_origin",
  "failure_stage",
  "field",
  "indexes",
  "label",
  "loopback_authority",
  "message_update",
  "operation",
  "outcome",
  "parameter",
  "persistent_index_worker_job",
  "publication_completeness",
  "query_keys",
  "request_type",
  "result",
  "route",
  "signal",
  "stage",
  "state",
  "status",
  "transport",
  "update",
  "validation_outcome",
  "version",
  "worker_level",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_TOKEN_PATTERN =
  /^(?:error_message|field|identifier|path|string|url):[a-f0-9]{16}$/;

const PATH_KEY_PATTERN = /(?:^|_)(?:cwd|directory|file|path|root)$/;
const URL_KEY_PATTERN = /(?:^|_)(?:origin|url)$/;
const SENSITIVE_KEY_SUFFIX_PATTERN =
  /(?:^|_)(?:api_key|authorization|cookie|credential|credentials|passphrase|passwd|password|private_key|secret|token)$/;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SECRET_QUERY_PATTERN =
  /([?&](?:access_token|api_key|apikey|password|secret|token)=)[^&#\s]*/gi;
const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const INCOMPLETE_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g;
const INCOMPLETE_JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/g;
const LINE_BREAK_PATTERN = /\r\n|[\n\r]/;

interface SanitizationBudget {
  remainingValues: number;
  remainingCharacters: number;
}

interface PersonalPrefixReplacement {
  prefix: string;
  replacement: string;
  pattern?: RegExp;
}

export interface EncodedLogLine {
  line: string;
  bytes: number;
  level: WorkerLogLevel;
}

export interface LogRecordInput {
  timestamp: string;
  level: WorkerLogLevel;
  event: string;
  runId: string;
  sequence: number;
  pid: number;
  threadId?: number;
  context?: WorkerLogContext;
  data: Record<string, unknown>;
}

interface LogRecordEncoderOptions {
  fingerprintKey: BinaryLike;
  maxRecordBytes: number;
  currentWorkingDirectory?: string;
  homeDirectory?: string;
}

function normalizedKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key) || SENSITIVE_KEY_SUFFIX_PATTERN.test(key);
}

function isIdentifierKey(key: string): boolean {
  return (
    !CORRELATION_ID_KEYS.has(key) &&
    (IDENTIFIER_KEYS.has(key) || /(?:^|_)(?:cursor|id|request_key|session_id)$/.test(key))
  );
}

function isAuditedString(key: string, value: string): boolean {
  if (
    (key === "agent" || key === "agent_name" || key === "agents" || key === "failed_agents") &&
    KNOWN_AGENT_NAMES.has(value)
  ) {
    return true;
  }
  if (key === "method" && HTTP_METHODS.has(value)) return true;
  return AUDITED_STRING_VALUES.get(key)?.has(value) === true;
}

function windowsPathPattern(value: string): RegExp | undefined {
  if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(value)) return undefined;
  const pattern = value
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\\\/]+");
  return new RegExp(pattern, "gi");
}

export class LogRecordEncoder {
  private readonly fingerprintKey: BinaryLike;
  private readonly maxRecordBytes: number;
  private readonly personalPrefixes: PersonalPrefixReplacement[];

  constructor(options: LogRecordEncoderOptions) {
    this.fingerprintKey = options.fingerprintKey;
    this.maxRecordBytes = Math.max(
      MIN_LOG_RECORD_BYTES,
      Number.isFinite(options.maxRecordBytes) ? Math.floor(options.maxRecordBytes) : 0,
    );
    const personalPrefixes: Array<[string, string]> = [
      [options.currentWorkingDirectory ?? process.cwd(), "<cwd>"],
      [options.homeDirectory ?? homedir(), "~"],
    ];
    this.personalPrefixes = personalPrefixes
      .toSorted(([left], [right]) => right.length - left.length)
      .map(([prefix, replacement]) => ({
        prefix,
        replacement,
        pattern: windowsPathPattern(prefix),
      }));
  }

  encode(input: LogRecordInput): EncodedLogLine {
    const budget = this.createSanitizationBudget();
    const trustedCorrelationIds = !input.event.startsWith("client.");
    const fixed = {
      schema_version: LOG_SCHEMA_VERSION,
      ts: input.timestamp,
      level: input.level,
      event: this.sanitizeEvent(input.event, budget),
      run_id: input.runId,
      seq: input.sequence,
      pid: input.pid,
      ...(input.threadId == null ? {} : { thread_id: input.threadId }),
    };
    const context = this.sanitizeContext(input.context, trustedCorrelationIds, budget);
    const data = this.sanitizeFields(input.data, trustedCorrelationIds, budget);
    const line = `${JSON.stringify({ ...data, ...context, ...fixed })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes <= this.maxRecordBytes) return { line, bytes, level: input.level };

    const truncatedLine = `${JSON.stringify({
      ...context,
      ...fixed,
      record_truncated: true,
      original_bytes: bytes,
    })}\n`;
    const truncatedBytes = Buffer.byteLength(truncatedLine);
    if (truncatedBytes <= this.maxRecordBytes) {
      return { line: truncatedLine, bytes: truncatedBytes, level: input.level };
    }

    const minimalLine = `${JSON.stringify({
      schema_version: LOG_SCHEMA_VERSION,
      ts: input.timestamp.slice(0, 40).replace(/[^0-9TZ:.-]/g, "_"),
      level: input.level,
      event: fixed.event.slice(0, 64),
      record_truncated: true,
      original_bytes: bytes,
    })}\n`;
    return {
      line: minimalLine,
      bytes: Buffer.byteLength(minimalLine),
      level: input.level,
    };
  }

  sanitizeForTransport(data: Record<string, unknown>, event = ""): Record<string, unknown> {
    const sanitized = this.sanitizeFields(
      data,
      !event.startsWith("client."),
      this.createSanitizationBudget(),
    );
    const bytes = Buffer.byteLength(JSON.stringify(sanitized));
    return bytes <= this.maxRecordBytes
      ? sanitized
      : { transport_truncated: true, original_bytes: bytes };
  }

  private sanitizeFields(
    data: Record<string, unknown>,
    trustedCorrelationIds: boolean,
    budget: SanitizationBudget,
  ): Record<string, unknown> {
    const normalized = this.sanitizeValue(
      data,
      "",
      0,
      new WeakSet(),
      trustedCorrelationIds,
      budget,
    );
    return normalized && typeof normalized === "object" && !Array.isArray(normalized)
      ? (normalized as Record<string, unknown>)
      : { diagnostic_data: normalized };
  }

  private sanitizeValue(
    value: unknown,
    key: string,
    depth: number,
    ancestors: WeakSet<object>,
    trustedCorrelationIds: boolean,
    budget: SanitizationBudget,
  ): unknown {
    if (budget.remainingValues <= 0 || budget.remainingCharacters <= 0) return TRUNCATED_VALUE;
    budget.remainingValues -= 1;

    const normalized = normalizedKey(this.takeKeyInput(key, budget));
    if (isSensitiveKey(normalized)) return REDACTED_VALUE;
    if (ERROR_TEXT_KEYS.has(normalized) && typeof value === "string") {
      return this.fingerprint("error_message", value, budget);
    }
    if (
      OMITTED_KEYS.has(normalized) &&
      value != null &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return OMITTED_VALUE;
    }
    const valueType = typeof value;
    if (
      (valueType === "function" || (valueType === "object" && value !== null)) &&
      types.isProxy(value)
    ) {
      return UNSERIALIZABLE_VALUE;
    }
    if (value == null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      return value === Number.POSITIVE_INFINITY
        ? "Infinity"
        : value === Number.NEGATIVE_INFINITY
          ? "-Infinity"
          : "NaN";
    }
    if (typeof value === "bigint") {
      return this.sanitizeString(value.toString(), normalized, budget, trustedCorrelationIds);
    }
    if (typeof value === "string") {
      if (normalized === "stack") return this.sanitizeStack(value, budget);
      return this.sanitizeString(value, normalized, budget, trustedCorrelationIds);
    }
    if (typeof value !== "object") return OMITTED_VALUE;
    if (depth >= MAX_DEPTH) return TRUNCATED_VALUE;
    if (ArrayBuffer.isView(value) || types.isAnyArrayBuffer(value)) {
      return OMITTED_VALUE;
    }
    if (ancestors.has(value)) return CIRCULAR_VALUE;

    ancestors.add(value);
    try {
      if (types.isDate(value)) {
        const timestamp = Date.prototype.getTime.call(value);
        return Number.isNaN(timestamp)
          ? this.takeLiteral("Invalid Date", budget)
          : this.takeLiteral(Date.prototype.toISOString.call(value), budget);
      }
      const url = this.urlString(value);
      if (url != null) {
        return this.sanitizeString(url, "url", budget, trustedCorrelationIds);
      }
      if (types.isNativeError(value)) {
        return this.sanitizeError(value, depth, ancestors, trustedCorrelationIds, budget);
      }
      if (Array.isArray(value)) {
        return this.sanitizeArray(value, key, depth, ancestors, trustedCorrelationIds, budget);
      }
      if (types.isMap(value)) {
        const result: unknown[] = [];
        for (const [mapKey, item] of Map.prototype.entries.call(value)) {
          result.push([
            this.sanitizeValue(mapKey, "key", depth + 1, ancestors, trustedCorrelationIds, budget),
            this.sanitizeValue(item, key, depth + 1, ancestors, trustedCorrelationIds, budget),
          ]);
          if (
            result.length >= MAX_ARRAY_ITEMS ||
            budget.remainingValues <= 0 ||
            budget.remainingCharacters <= 0
          ) {
            break;
          }
        }
        return result;
      }
      if (types.isSet(value)) {
        const result: unknown[] = [];
        for (const item of Set.prototype.values.call(value)) {
          result.push(
            this.sanitizeValue(item, key, depth + 1, ancestors, trustedCorrelationIds, budget),
          );
          if (
            result.length >= MAX_ARRAY_ITEMS ||
            budget.remainingValues <= 0 ||
            budget.remainingCharacters <= 0
          ) {
            break;
          }
        }
        return result;
      }
      return this.sanitizeObject(value, depth, ancestors, trustedCorrelationIds, budget);
    } catch {
      return UNSERIALIZABLE_VALUE;
    } finally {
      ancestors.delete(value);
    }
  }

  private sanitizeObject(
    value: object,
    depth: number,
    ancestors: WeakSet<object>,
    trustedCorrelationIds: boolean,
    budget: SanitizationBudget,
  ): Record<string, unknown> | string {
    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(value).slice(0, MAX_OBJECT_FIELDS);
    } catch {
      return UNSERIALIZABLE_VALUE;
    }

    const result: Record<string, unknown> = {};
    for (const key of keys) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        result[this.boundedFieldName(key, budget)] = UNSERIALIZABLE_VALUE;
        if (budget.remainingCharacters <= 0) break;
        continue;
      }
      if (!descriptor) continue;

      result[this.boundedFieldName(key, budget)] =
        "value" in descriptor
          ? this.sanitizeValue(
              descriptor.value,
              key,
              depth + 1,
              ancestors,
              trustedCorrelationIds,
              budget,
            )
          : ACCESSOR_VALUE;
      if (budget.remainingValues <= 0 || budget.remainingCharacters <= 0) break;
    }
    return result;
  }

  private sanitizeArray(
    value: unknown[],
    key: string,
    depth: number,
    ancestors: WeakSet<object>,
    trustedCorrelationIds: boolean,
    budget: SanitizationBudget,
  ): unknown[] {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length =
      lengthDescriptor && "value" in lengthDescriptor && typeof lengthDescriptor.value === "number"
        ? Math.min(lengthDescriptor.value, MAX_ARRAY_ITEMS)
        : 0;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      result.push(
        !descriptor
          ? null
          : "value" in descriptor
            ? this.sanitizeValue(
                descriptor.value,
                key,
                depth + 1,
                ancestors,
                trustedCorrelationIds,
                budget,
              )
            : ACCESSOR_VALUE,
      );
      if (budget.remainingValues <= 0 || budget.remainingCharacters <= 0) break;
    }
    return result;
  }

  private sanitizeError(
    error: Error,
    depth: number,
    ancestors: WeakSet<object>,
    trustedCorrelationIds: boolean,
    budget: SanitizationBudget,
  ): Record<string, unknown> {
    const code = this.errorProperty(error, "code");
    const cause = this.errorProperty(error, "cause");
    const message = this.errorStringProperty(error, "message", "");
    const stack = this.errorStringProperty(error, "stack", "");
    return {
      name: this.sanitizeString(
        this.errorStringProperty(error, "name", "Error"),
        "name",
        budget,
        trustedCorrelationIds,
      ),
      message_fingerprint: this.fingerprint("error_message", message, budget),
      stack: this.sanitizeStack(stack, budget),
      ...(code == null
        ? {}
        : {
            code: this.sanitizeValue(
              code,
              "code",
              depth + 1,
              ancestors,
              trustedCorrelationIds,
              budget,
            ),
          }),
      ...(cause == null
        ? {}
        : {
            cause: this.sanitizeValue(
              cause,
              "cause",
              depth + 1,
              ancestors,
              trustedCorrelationIds,
              budget,
            ),
          }),
    };
  }

  private errorProperty(error: Error, key: string): unknown {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (!descriptor) return undefined;
      return "value" in descriptor ? descriptor.value : ACCESSOR_VALUE;
    } catch {
      return UNSERIALIZABLE_VALUE;
    }
  }

  private errorStringProperty(error: Error, key: string, fallback: string): string {
    const value = this.errorProperty(error, key);
    return value == null ? fallback : typeof value === "string" ? value : UNSERIALIZABLE_VALUE;
  }

  private urlString(value: object): string | undefined {
    try {
      return URL.prototype.toString.call(value);
    } catch {
      return undefined;
    }
  }

  private createSanitizationBudget(): SanitizationBudget {
    return {
      remainingValues: MAX_SANITIZED_VALUES,
      remainingCharacters: Math.max(0, Math.floor(this.maxRecordBytes)),
    };
  }

  private sanitizeContext(
    context: WorkerLogContext | undefined,
    trustedCorrelationIds: boolean,
    budget: SanitizationBudget,
  ): WorkerLogContext {
    if (!context) return {};
    return Object.fromEntries(
      Object.entries(context).flatMap(([key, value]) =>
        LOG_CONTEXT_KEYS.has(key as keyof WorkerLogContext) &&
        typeof value === "string" &&
        value.length > 0
          ? [
              [
                key,
                this.sanitizeString(value, normalizedKey(key), budget, trustedCorrelationIds).slice(
                  0,
                  160,
                ),
              ],
            ]
          : [],
      ),
    );
  }

  private sanitizeEvent(event: string, budget: SanitizationBudget): string {
    return this.takePrefix(event, budget)
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]/g, "_")
      .slice(0, 160);
  }

  private sanitizeString(
    value: string,
    key: string,
    budget: SanitizationBudget,
    trustedCorrelationIds = false,
  ): string {
    if (FINGERPRINT_TOKEN_PATTERN.test(value) || SAFE_SENTINELS.has(value)) {
      return this.takeLiteral(value, budget);
    }
    if (CORRELATION_ID_KEYS.has(key)) {
      return trustedCorrelationIds || UUID_PATTERN.test(value)
        ? this.takeLiteral(value, budget)
        : this.fingerprint("identifier", value, budget);
    }
    if (isAuditedString(key, value)) return this.takeLiteral(value, budget);
    if (isIdentifierKey(key)) return this.fingerprint("identifier", value, budget);
    if (trustedCorrelationIds && INTERNAL_PLAINTEXT_KEYS.has(key)) {
      const bounded = this.takePrefix(value, budget);
      return this.sanitizeBoundedString(bounded, key, bounded.length < value.length);
    }
    if (PATH_KEY_PATTERN.test(key)) return this.fingerprint("path", value, budget);
    if (
      URL_KEY_PATTERN.test(key) &&
      value.length > Math.min(MAX_STRING_LENGTH, budget.remainingCharacters)
    ) {
      return this.fingerprint("url", value, budget);
    }
    if (URL_KEY_PATTERN.test(key)) {
      const bounded = this.takePrefix(value, budget);
      return this.sanitizeBoundedString(bounded, key, bounded.length < value.length);
    }
    return this.fingerprint("string", value, budget);
  }

  private takeLiteral(value: string, budget: SanitizationBudget): string {
    if (value.length > budget.remainingCharacters) return TRUNCATED_VALUE;
    budget.remainingCharacters -= value.length;
    return value;
  }

  private sanitizeStack(value: string, budget: SanitizationBudget): string {
    const bounded = this.takePrefix(value, budget);
    const inputTruncated = bounded.length < value.length;
    const startsWithFrame = /^\s*at(?:\s|$)/.test(bounded);
    const lineBreak = LINE_BREAK_PATTERN.exec(bounded);
    if (!startsWithFrame && !lineBreak) return inputTruncated ? TRUNCATED_VALUE : "";

    const stackBody = startsWithFrame
      ? bounded
      : bounded.slice(lineBreak!.index + lineBreak![0].length);
    const sanitized = this.sanitizeBoundedString(stackBody, "stack", inputTruncated);
    return inputTruncated && !sanitized.endsWith(TRUNCATED_VALUE)
      ? `${sanitized}[truncated]`
      : sanitized;
  }

  private sanitizeBoundedString(value: string, key: string, inputTruncated: boolean): string {
    let sanitized = value
      .replace(PRIVATE_KEY_PATTERN, REDACTED_VALUE)
      .replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`)
      .replace(JWT_PATTERN, REDACTED_VALUE)
      .replace(SECRET_QUERY_PATTERN, `$1${REDACTED_VALUE}`);
    if (inputTruncated) {
      sanitized = sanitized
        .replace(INCOMPLETE_PRIVATE_KEY_PATTERN, REDACTED_VALUE)
        .replace(INCOMPLETE_JWT_PATTERN, REDACTED_VALUE);
    }
    if (URL_KEY_PATTERN.test(key)) sanitized = this.sanitizeUrl(sanitized);
    sanitized = this.replacePersonalPrefixes(sanitized);
    return !inputTruncated && sanitized.length <= MAX_STRING_LENGTH
      ? sanitized
      : `${sanitized.slice(0, MAX_STRING_LENGTH)}[truncated]`;
  }

  private takePrefix(value: string, budget: SanitizationBudget): string {
    const length = Math.min(value.length, MAX_STRING_LENGTH, budget.remainingCharacters);
    budget.remainingCharacters -= length;
    return value.slice(0, length);
  }

  private takeKeyInput(key: string, budget: SanitizationBudget): string {
    const length = Math.min(key.length, MAX_STRING_LENGTH, budget.remainingCharacters);
    budget.remainingCharacters -= length;
    if (length >= key.length) return key;
    if (length === 0) return "";
    if (length < 3) return key.slice(-length);

    const contentLength = length - 1;
    const prefixLength = Math.ceil(contentLength / 2);
    return `${key.slice(0, prefixLength)}_${key.slice(-(contentLength - prefixLength))}`;
  }

  private boundedFieldName(key: string, budget: SanitizationBudget): string {
    if (key.length <= MAX_STRING_LENGTH && key.length <= budget.remainingCharacters) {
      budget.remainingCharacters -= key.length;
      return key;
    }
    return this.fingerprint("field", key, budget);
  }

  private sanitizeUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return OMITTED_VALUE;
    }
    return url.origin === "null" ? OMITTED_VALUE : `${url.origin}/`;
  }

  private replacePersonalPrefixes(value: string): string {
    return this.personalPrefixes.reduce(
      (text, { prefix, replacement, pattern }) =>
        pattern ? text.replace(pattern, replacement) : text.split(prefix).join(replacement),
      value,
    );
  }

  private fingerprint(kind: string, value: string, budget: SanitizationBudget): string {
    if (FINGERPRINT_TOKEN_PATTERN.test(value)) return this.takeLiteral(value, budget);
    const suffix = `\0${value.length}`;
    const contentLength = MAX_STRING_LENGTH - suffix.length;
    const prefixLength = Math.ceil(contentLength / 2);
    const bounded =
      value.length <= MAX_STRING_LENGTH
        ? value
        : `${value.slice(0, prefixLength)}${value.slice(-(contentLength - prefixLength))}${suffix}`;
    if (bounded.length > budget.remainingCharacters) return TRUNCATED_VALUE;
    budget.remainingCharacters -= bounded.length;
    const digest = createHmac("sha256", this.fingerprintKey)
      .update(bounded)
      .digest("hex")
      .slice(0, 16);
    return `${kind}:${digest}`;
  }
}
