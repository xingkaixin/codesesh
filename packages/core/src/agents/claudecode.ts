import { existsSync, readFileSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { SingleFileSessionSource, filteredSession, parsedSession, skippedSession } from "./base.js";
import type { ParseSessionResult } from "./base.js";
import type { Message, SessionHead, SessionDetail } from "../types/index.js";
import { firstExisting, resolveHomePath } from "../discovery/paths.js";
import { readJsonlFile, readJsonlFileLines } from "../utils/jsonl.js";
import { basenameTitle, normalizeTitleText, resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asRecord, asString, reportFieldMismatch } from "../utils/narrow.js";
import {
  matchesScanWindow,
  type AgentScanOptions,
  type FileSessionMeta,
  type SessionCacheMeta,
  type SessionSourceFile,
  type SessionSourceRef,
} from "./base.js";
import {
  ClaudeRecordConverter,
  extractClaudeUsage,
  parseClaudeTimestampMs,
  type ClaudeUsage,
} from "./claudecode-record-converter.js";
import { TranscriptBuilder } from "./transcript-builder.js";

// v8: request usage uses the final snapshot, shared by heads and message costs.
const HEAD_INDEX_VERSION = "claudecode-head-v8";

export function resolveClaudeCodeDataRoot(): string {
  return resolveHomePath("CLAUDE_CONFIG_DIR", ".claude");
}

interface SessionMeta extends FileSessionMeta {
  indexPath: string | null;
  indexMtimeMs: number | null;
  headIndexVersion: string;
  model: string | null | undefined;
  parentSessionId: string | null;
  toolUseId: string | null;
}

interface ClaudeChildContext {
  sessionId: string;
  projectDir: string;
  parentSessionId: string | null;
  explicitTitle: string | null;
  metaMtimeMs: number | null;
  toolUseId: string | null;
}

interface ClaudeChildContextCacheEntry {
  metaMtimeMs: number | null;
  context: ClaudeChildContext;
}

const CLAUDE_RECORD_CONVERTER = new ClaudeRecordConverter();

const AGENT_METADATA = getAgentCatalogEntry("claudecode");

export class ClaudeCodeAgent extends SingleFileSessionSource<SessionMeta> {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;

  private basePath: string | null = this.configuredSourceRoot;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sessionsIndexCache: Record<string, any> = {};
  private sessionsIndexMtime: Record<string, number | null> = {};
  private childContextsBySource = new Map<string, ClaudeChildContext>();
  private childContextCache = new Map<string, ClaudeChildContextCacheEntry>();
  private childSessionIdByToolUseId = new Map<string, string>();
  private childIndexReady = false;

  private findBasePath(): string | null {
    return (
      this.configuredSourceRoot ??
      firstExisting(join(resolveClaudeCodeDataRoot(), "projects"), "data/claudecode")
    );
  }

  getSessionWatchPlan() {
    if (this.configuredSourceRoot) {
      return {
        status: "supported" as const,
        targets: [{ root: dirname(this.configuredSourceRoot), path: this.configuredSourceRoot }],
      };
    }
    const dataRoot = resolveClaudeCodeDataRoot();
    return {
      status: "supported" as const,
      targets: [{ root: dataRoot, path: join(dataRoot, "projects") }, { path: "data/claudecode" }],
    };
  }

  isAvailable(): boolean {
    this.basePath = this.findBasePath();
    if (!this.basePath) return false;
    for (const entry of this.readSessionSourceDirectory(this.basePath)) {
      if (!entry.isDirectory()) continue;
      const directory = join(this.basePath, entry.name);
      if (
        this.readSessionSourceDirectory(directory).some(
          (child) => child.isFile() && child.name.endsWith(".jsonl"),
        )
      ) {
        return true;
      }
    }
    return false;
  }

  listSessionSources(options?: AgentScanOptions): SessionSourceRef[] {
    if (!this.basePath) return [];
    const projectDirs = this.listProjectDirs();
    const indexMtimes = new Map<string, number | null>();
    for (const projectDir of projectDirs) {
      const indexPath = this.getSessionsIndexPath(projectDir);
      indexMtimes.set(projectDir, this.readFileMtimeMs(indexPath));
    }

    const projectDirSet = new Set(projectDirs);
    const allSources = this.walkFiles(projectDirs, (entry) => entry.name.endsWith(".jsonl"), {
      recursive: true,
    });
    this.indexChildContexts(allSources, projectDirs);
    const indexedSources = allSources.flatMap((source) => {
      const child = this.childContextsBySource.get(source.file);
      if (!child && !projectDirSet.has(dirname(source.file))) return [];
      return [
        {
          source,
          sessionId: child?.sessionId ?? basename(source.file, ".jsonl"),
          child,
        },
      ];
    });
    let selectedSources = indexedSources.filter(({ source }) =>
      matchesScanWindow(source.stat.mtimeMs, options),
    );

    if (options?.from != null || options?.to != null) {
      type IndexedSource = (typeof indexedSources)[number];
      const childrenByParent = new Map<string, IndexedSource[]>();
      for (const indexed of indexedSources) {
        const parentId = indexed.child?.parentSessionId;
        if (!parentId) continue;
        const children = childrenByParent.get(parentId);
        if (children) children.push(indexed);
        else childrenByParent.set(parentId, [indexed]);
      }

      const windowSelectedById = new Map(
        selectedSources.map((indexed) => [indexed.sessionId, indexed]),
      );
      const connectedSelected = new Map<string, IndexedSource>();
      const acceptedIds = new Set<string>();
      const visitingIds = new Set<string>();
      const hasSelectedParent = (sessionId: string): boolean => {
        if (acceptedIds.has(sessionId)) return true;
        if (visitingIds.has(sessionId)) return false;

        const indexed = windowSelectedById.get(sessionId);
        if (!indexed) return false;
        const parentId = indexed.child?.parentSessionId;
        if (!parentId) {
          acceptedIds.add(sessionId);
          return true;
        }

        visitingIds.add(sessionId);
        const connected = hasSelectedParent(parentId);
        visitingIds.delete(sessionId);
        if (connected) acceptedIds.add(sessionId);
        return connected;
      };

      for (const indexed of selectedSources) {
        if (hasSelectedParent(indexed.sessionId)) {
          connectedSelected.set(indexed.sessionId, indexed);
        }
      }

      if (options?.includeRelatedSessions !== false) {
        const pending = [...connectedSelected.values()]
          .filter(({ child }) => !child?.parentSessionId)
          .map(({ sessionId }) => sessionId);
        while (pending.length > 0) {
          const parentId = pending.pop()!;
          for (const child of childrenByParent.get(parentId) ?? []) {
            if (connectedSelected.has(child.sessionId)) continue;
            connectedSelected.set(child.sessionId, child);
            pending.push(child.sessionId);
          }
        }
      }

      selectedSources = [...connectedSelected.values()];
    }

    return selectedSources.map(({ source: { file, stat }, sessionId, child }) => {
      const projectDir = child?.projectDir ?? dirname(file);
      return {
        sessionId,
        sourcePath: file,
        fingerprint: this.sourceFingerprint(
          stat,
          indexMtimes.get(projectDir) ?? null,
          child?.metaMtimeMs,
        ),
      };
    });
  }

  restoreSessionCacheMeta(meta: Readonly<Record<string, SessionCacheMeta>>): void {
    const childIndexInputsChanged = this.childIndexReady && this.didChildIndexInputsChange(meta);
    super.restoreSessionCacheMeta(meta);
    if (!childIndexInputsChanged) return;
    this.childContextsBySource.clear();
    this.childSessionIdByToolUseId.clear();
    this.childIndexReady = false;
  }

  protected override parseFileSessionHeadResult(
    sourcePath: string,
  ): ParseSessionResult<SessionHead> {
    const child = this.getChildContext(sourcePath);
    const projectDir = child?.projectDir ?? dirname(sourcePath);
    return this.parseSessionHeadResult(sourcePath, projectDir, child);
  }

  getSessionData(sessionId: string): SessionDetail {
    const meta = this.sessionMetaMap.get(sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!existsSync(meta.sourcePath)) {
      throw new Error(`Session file missing: ${meta.sourcePath}`);
    }

    this.ensureChildIndex();
    const builder = new TranscriptBuilder();
    const assistantUuidToToolCalls = new Map<string, string[]>();
    const requestMessages = new Map<string, Message>();
    for (const record of readJsonlFile(meta.sourcePath)) {
      try {
        CLAUDE_RECORD_CONVERTER.convertRecord(
          record,
          builder,
          assistantUuidToToolCalls,
          requestMessages,
          this.childSessionIdByToolUseId,
        );
      } catch {
        // skip malformed records
      }
    }

    const transcript = builder.finish();

    return {
      ...this.sessionIdentity(meta.id),
      title: meta.title,
      directory: meta.directory,
      parent_reference:
        meta.parentSessionId == null
          ? undefined
          : { agentName: this.name, sessionId: meta.parentSessionId },
      version: undefined,
      time_created: meta.createdAt,
      time_updated: meta.updatedAt,
      stats: transcript.stats,
      messages: transcript.messages,
    };
  }

  // --- Private helpers ---

  private listProjectDirs(): string[] {
    if (!this.basePath) return [];
    return this.readSessionSourceDirectory(this.basePath)
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(this.basePath!, entry.name));
  }

  private didChildIndexInputsChange(meta: Readonly<Record<string, SessionCacheMeta>>): boolean {
    if (Object.keys(meta).length !== this.sessionMetaMap.size) return true;

    for (const [sessionId, next] of Object.entries(meta)) {
      const current = this.sessionMetaMap.get(sessionId);
      if (!current || current.sourcePath !== next.sourcePath) return true;
      if (
        basename(dirname(next.sourcePath)) === "subagents" &&
        (current.title !== next["title"] ||
          current.parentSessionId !== next["parentSessionId"] ||
          this.readToolUseId(current) !== this.readToolUseId(next))
      ) {
        return true;
      }
    }

    return false;
  }

  private readToolUseId(meta: SessionCacheMeta): string | null {
    const value = meta["toolUseId"];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private ensureChildIndex(): void {
    if (this.childIndexReady) return;
    this.basePath ??= this.findBasePath();
    if (!this.basePath) {
      this.childIndexReady = true;
      return;
    }

    const projectDirs = this.listProjectDirs();
    this.indexChildContexts(
      this.walkFiles(projectDirs, (entry) => entry.name.endsWith(".jsonl"), {
        recursive: true,
      }),
      projectDirs,
    );
  }

  private indexChildContexts(
    sources: readonly SessionSourceFile[],
    projectDirs: readonly string[],
  ): void {
    this.childContextsBySource.clear();
    this.childSessionIdByToolUseId.clear();
    const projectDirSet = new Set(projectDirs);
    const contexts = new Map<string, ClaudeChildContext>();
    const knownSessionIds = new Set<string>();

    for (const source of sources) {
      const child = this.readChildContext(source.file);
      if (!child) {
        if (projectDirSet.has(dirname(source.file))) {
          knownSessionIds.add(basename(source.file, ".jsonl"));
        }
        continue;
      }
      contexts.set(source.file, child);
      knownSessionIds.add(child.sessionId);
    }

    for (const [sourcePath, child] of contexts) {
      const parentSessionId =
        child.parentSessionId && knownSessionIds.has(child.parentSessionId)
          ? child.parentSessionId
          : null;
      const normalized =
        parentSessionId === child.parentSessionId ? child : { ...child, parentSessionId };
      this.childContextsBySource.set(sourcePath, normalized);
      if (child.toolUseId) {
        this.childSessionIdByToolUseId.set(child.toolUseId, normalized.sessionId);
      }
    }

    this.childIndexReady = true;
  }

  private getChildContext(sourcePath: string): ClaudeChildContext | null {
    const cached = this.childContextsBySource.get(sourcePath);
    if (cached) return cached;

    const child = this.readChildContext(sourcePath);
    if (!child) return null;
    this.childContextsBySource.set(sourcePath, child);
    if (child.toolUseId) {
      this.childSessionIdByToolUseId.set(child.toolUseId, child.sessionId);
    }
    return child;
  }

  private readChildContext(sourcePath: string): ClaudeChildContext | null {
    const subagentsDir = dirname(sourcePath);
    if (basename(subagentsDir) !== "subagents") return null;

    const parentDir = dirname(subagentsDir);
    // Claude stores nested transcripts flat here; parentAgentId carries the nesting relation.
    const projectDir = dirname(parentDir);
    const fileStem = basename(sourcePath, ".jsonl");
    const metaPath = join(subagentsDir, fileStem + ".meta.json");
    const metaMtimeMs = this.readFileMtimeMs(metaPath);
    const cached = this.childContextCache.get(sourcePath);
    if (cached?.metaMtimeMs === metaMtimeMs) return cached.context;

    let metadata: Record<string, unknown> | null = null;
    if (metaMtimeMs !== null) {
      try {
        metadata = asRecord(JSON.parse(readFileSync(metaPath, "utf-8"))) ?? null;
      } catch {
        // Child transcripts can outlive their metadata during an interrupted spawn.
      }
    }

    const sessionId = asString(metadata?.["agentId"])?.trim() || fileStem.replace(/^agent-/, "");
    if (!sessionId) return null;

    const parentAgentId = asString(metadata?.["parentAgentId"])?.trim();
    const candidateParentId = parentAgentId || basename(parentDir) || null;
    const parentSessionId =
      candidateParentId && this.hasChildParent(sourcePath, projectDir, candidateParentId)
        ? candidateParentId
        : null;
    const name = asString(metadata?.["name"])?.trim();
    const description = asString(metadata?.["description"])?.trim();

    const context = {
      sessionId,
      projectDir,
      parentSessionId,
      explicitTitle: name || description || null,
      metaMtimeMs,
      toolUseId: asString(metadata?.["toolUseId"])?.trim() || null,
    };
    this.childContextCache.set(sourcePath, { metaMtimeMs, context });
    return context;
  }

  private hasChildParent(sourcePath: string, projectDir: string, parentSessionId: string): boolean {
    const subagentsDir = dirname(sourcePath);
    return [
      join(projectDir, parentSessionId + ".jsonl"),
      join(subagentsDir, "agent-" + parentSessionId + ".jsonl"),
      join(subagentsDir, parentSessionId + ".jsonl"),
    ].some((path) => existsSync(path));
  }

  protected createFileSessionMeta(head: SessionHead, source: SessionSourceFile): SessionMeta {
    const child = this.getChildContext(source.file);
    const projectDir = child?.projectDir ?? dirname(source.file);
    const indexPath = this.getSessionsIndexPath(projectDir);
    const indexMtime = this.readFileMtimeMs(indexPath);
    return this.buildFileSessionMeta({
      head,
      source,
      fingerprint: this.sourceFingerprint(source.stat, indexMtime, child?.metaMtimeMs),
      extras: {
        indexPath: indexMtime === null ? null : indexPath,
        indexMtimeMs: indexMtime,
        headIndexVersion: HEAD_INDEX_VERSION,
        model: head.stats.total_tokens ? "unknown" : undefined,
        parentSessionId: head.parent_reference?.sessionId ?? null,
        toolUseId: child?.toolUseId ?? null,
      },
    });
  }

  /** Fingerprint depends on an already-fetched stat to avoid re-statting the same file. */
  private sourceFingerprint(
    stat: { mtimeMs: number; size: number },
    indexMtime: number | null,
    metaMtime?: number | null,
  ): string {
    const fingerprint = [HEAD_INDEX_VERSION, stat.mtimeMs, stat.size, indexMtime];
    if (metaMtime !== undefined) fingerprint.push(metaMtime);
    return JSON.stringify(fingerprint);
  }

  private getSessionsIndexPath(projectDir: string): string {
    return join(projectDir, "sessions-index.json");
  }

  private loadSessionsIndex(projectDir: string): Map<string, Record<string, unknown>> {
    const cacheKey = basename(projectDir);
    const indexPath = this.getSessionsIndexPath(projectDir);
    const mtime = this.readFileMtimeMs(indexPath);

    // Invalidate when the index file mtime advances so long-running processes
    // pick up title changes without relying on callers to evict manually.
    if (cacheKey in this.sessionsIndexCache && this.sessionsIndexMtime[cacheKey] === mtime) {
      return this.sessionsIndexCache[cacheKey];
    }

    const map = new Map<string, Record<string, unknown>>();

    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, "utf-8"));
        const entries: Record<string, unknown>[] = data?.entries ?? [];
        for (const entry of entries) {
          const sid = entry?.sessionId;
          if (typeof sid === "string") {
            map.set(sid, entry);
          }
        }
      } catch {
        // ignore
      }
    }

    this.sessionsIndexCache[cacheKey] = map;
    this.sessionsIndexMtime[cacheKey] = mtime;
    return map;
  }

  private parseSessionHeadResult(
    filePath: string,
    projectDir: string,
    child?: ClaudeChildContext | null,
  ): ParseSessionResult<SessionHead> {
    const sessionId = child?.sessionId ?? basename(filePath, ".jsonl");

    // Try to get title from sessions-index.json
    const index = this.loadSessionsIndex(projectDir);
    const indexEntry = index.get(sessionId);
    const explicitTitle =
      child?.explicitTitle ?? (indexEntry?.summary ? String(indexEntry.summary) : null);

    // Extract lightweight metadata; cwd lives in user-type records, not the first line
    let createdAt = 0;
    let updatedAt = 0;
    let lineIndex = 0;
    let messageCount = 0;
    let model: string | null = null;
    let cwd: string | null = null;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreateTokens = 0;
    let totalCost = 0;
    const modelUsageMap: Record<string, number> = {};
    const usageByRequest = new Map<string, ClaudeUsage>();
    let messageTitle: string | null = null;

    for (const line of readJsonlFileLines(filePath)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // A malformed opening record means the file is not a session we can read;
        // later ones are individually skippable.
        if (lineIndex === 0) return skippedSession("malformed first record");
        lineIndex += 1;
        continue;
      }

      if (lineIndex === 0) {
        createdAt = parseClaudeTimestampMs(data) || statSync(filePath).mtimeMs;
        updatedAt = createdAt;
      }
      const recordIndex = lineIndex;
      lineIndex += 1;

      try {
        if (isInternalEventType(data["type"])) continue;
        if (data["isMeta"] === true) continue;
        const ts = parseClaudeTimestampMs(data);
        if (ts > updatedAt) updatedAt = ts;

        if (!cwd && data["cwd"] && typeof data["cwd"] === "string") {
          cwd = data["cwd"];
        }

        const msg = asRecord(data["message"]);
        if (!msg && data["message"] !== undefined && data["message"] !== null) {
          reportFieldMismatch("claudecode", "message");
        }
        if (msg) {
          const role = asString(msg["role"]);
          if (msg["role"] !== undefined && role === undefined) {
            reportFieldMismatch("claudecode", "message.role");
          }
          const userTitle = role === "user" ? this.extractUserMessageTitle(msg["content"]) : null;
          if (role?.trim() && (role !== "user" || userTitle !== null)) {
            messageCount++;
          }
          if (!model) {
            const m = asString(msg["model"]);
            if (m?.trim()) model = m.trim();
          }
          // Title fallback mirrors the removed extractTitle(): first non-empty
          // visible user text within the first 20 lines.
          if (messageTitle === null && recordIndex < 20 && userTitle) {
            messageTitle = userTitle;
          }
          if (role === "assistant") {
            const usage = extractClaudeUsage(data, msg);
            if (usage) usageByRequest.set(usage.key, usage);
          }
        }
      } catch {
        // skip
      }
    }

    if (lineIndex === 0) return skippedSession("empty file");

    for (const usage of usageByRequest.values()) {
      const input = usage.input + usage.cacheRead + usage.cacheCreate;
      totalInputTokens += input;
      totalOutputTokens += usage.output;
      totalCacheReadTokens += usage.cacheRead;
      totalCacheCreateTokens += usage.cacheCreate;
      if (!usage.model) continue;
      modelUsageMap[usage.model] = (modelUsageMap[usage.model] ?? 0) + input + usage.output;
      totalCost +=
        estimateTokenCost(usage.model, {
          input,
          output: usage.output,
          cache_read: usage.cacheRead,
          cache_create: usage.cacheCreate,
        }) ?? 0;
    }

    const directory = cwd ?? projectDir;
    const directoryTitle = basenameTitle(directory) || basenameTitle(projectDir);

    const title = resolveSessionTitle(explicitTitle, messageTitle, directoryTitle);

    const hasModelUsage = Object.keys(modelUsageMap).length > 0;
    if (messageCount === 0) return filteredSession("no visible messages");

    return parsedSession({
      ...this.sessionIdentity(sessionId),
      title,
      directory,
      parent_reference:
        child?.parentSessionId == null
          ? undefined
          : { agentName: this.name, sessionId: child.parentSessionId },
      time_created: createdAt,
      time_updated: updatedAt,
      stats: {
        message_count: messageCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? "estimated" : undefined,
        total_cache_read_tokens: totalCacheReadTokens,
        total_cache_create_tokens: totalCacheCreateTokens,
      },
      model_usage: hasModelUsage ? modelUsageMap : undefined,
    });
  }

  /** Mirrors the title-candidate extraction previously done in a second JSON.parse pass. */
  private extractUserMessageTitle(content: unknown): string | null {
    if (!content) return null;

    if (typeof content === "string") {
      const title = normalizeTitleText(content);
      return title || null;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter((item): item is Record<string, unknown> => {
          const record = asRecord(item);
          return record !== undefined && "text" in record;
        })
        .map((item) => String(item["text"] ?? ""))
        .join(" ");
      const title = normalizeTitleText(texts);
      return title || null;
    }
    return null;
  }
}
