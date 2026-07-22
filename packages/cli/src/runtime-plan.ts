import type { ScanOptions } from "@codesesh/core";
import { resolveTimeWindow, type TimeWindow } from "./time-window-resolution.js";

export interface TargetSession {
  agent: string;
  sessionId: string;
}

interface CliRuntimePlanInput {
  agent?: string;
  cwd?: string;
  from?: string;
  to?: string;
  days?: string;
  jsonOnly: boolean;
  useCache: boolean;
  targetSession: TargetSession | null;
}

interface CliRuntimeEnvironment {
  currentWorkingDirectory: string;
  now?: number;
}

export interface CliRuntimePlan {
  listWindow: TimeWindow;
  scanOptions: ScanOptions;
  startupScanOptions: Pick<ScanOptions, "from" | "to">;
}

export function parseSessionUri(uri: string): TargetSession | null {
  const match = uri.match(/^([a-z]+):\/\/(.+)$/i);
  if (!match) return null;
  return { agent: match[1]!, sessionId: match[2]! };
}

export function buildCliRuntimePlan(
  input: CliRuntimePlanInput,
  environment: CliRuntimeEnvironment,
): CliRuntimePlan {
  const listWindow = resolveTimeWindow({
    mode: "cli",
    from: input.from,
    to: input.to,
    days: input.days,
    now: environment.now,
  });
  const cwd = input.cwd === "." ? environment.currentWorkingDirectory : input.cwd;
  const agents = input.targetSession
    ? [input.targetSession.agent]
    : input.agent
      ? input.agent.split(",").map((agent) => agent.trim())
      : undefined;

  return {
    listWindow,
    scanOptions: { agents, cwd, useCache: input.useCache },
    startupScanOptions:
      input.targetSession || input.jsonOnly ? {} : { from: listWindow.from, to: listWindow.to },
  };
}

export function resolveStartupUrl(startupUrl: string, targetSession: TargetSession | null): string {
  if (!targetSession) return startupUrl;
  const url = new URL(startupUrl);
  url.pathname = `/${targetSession.agent.toLowerCase()}/${targetSession.sessionId}`;
  return url.toString();
}

export function redactStartupUrl(startupUrl: string): string {
  const url = new URL(startupUrl);
  for (const key of url.searchParams.keys()) {
    url.searchParams.set(key, "[redacted]");
  }
  return url.toString();
}
