import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getRegisteredAgents } from "@codesesh/core";
import { describe, expect, it } from "vitest";
import { hasCustomToolStrategy } from "../src/components/session-detail/tool-strategy";

const WEB_ROOT = existsSync(resolve(process.cwd(), "public/icon/agent"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/web");
const PUBLIC_ROOT = resolve(WEB_ROOT, "public");
const AGENT_ICON_ROOT = resolve(PUBLIC_ROOT, "icon/agent");

function registrationName(registration: ReturnType<typeof getRegisteredAgents>[number]): string {
  return registration.create().name;
}

describe("agent registration completeness", () => {
  it("requires every registration to declare resolvers, resume support, and its tool strategy", () => {
    const incomplete = getRegisteredAgents()
      .filter((registration) => {
        const validResumePrefix =
          registration.resumeCommandPrefix === null ||
          registration.resumeCommandPrefix.trim().length > 0;
        const customStrategy = registration.toolStrategy === "custom";
        return (
          typeof registration.resolveDataRoot !== "function" ||
          !validResumePrefix ||
          hasCustomToolStrategy(registrationName(registration)) !== customStrategy
        );
      })
      .map(registrationName);

    expect(incomplete).toEqual([]);
  });

  it("keeps the agent icon directory aligned with registered icons", () => {
    const registeredIcons = getRegisteredAgents()
      .map((registration) => {
        const iconPath = resolve(PUBLIC_ROOT, registration.icon.replace(/^\/+/, ""));
        expect(existsSync(iconPath), `${registrationName(registration)} icon`).toBe(true);
        return basename(iconPath);
      })
      .toSorted();
    const iconFiles = readdirSync(AGENT_ICON_ROOT)
      .filter((file) => file.endsWith(".svg"))
      .toSorted();

    expect(iconFiles).toEqual(registeredIcons);
  });
});
