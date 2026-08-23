import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getRegisteredAgents } from "@codesesh/core/runtime/agents";
import { describe, expect, it } from "vitest";
import { hasCustomToolStrategy } from "../src/components/session-detail/tool-strategy";

const REPO_ROOT = existsSync(resolve(process.cwd(), "apps/web"))
  ? process.cwd()
  : resolve(process.cwd(), "../..");
const WEB_PUBLIC_ROOT = resolve(REPO_ROOT, "apps/web/public");
const WWW_PUBLIC_ROOT = resolve(REPO_ROOT, "apps/www/public");
const AGENT_ICON_ROOT = resolve(WEB_PUBLIC_ROOT, "icon/agent");

function registrationName(registration: ReturnType<typeof getRegisteredAgents>[number]): string {
  return registration.name;
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

  it("provides every registered icon to the app and product site", () => {
    const registeredIcons = [
      ...new Set(
        getRegisteredAgents().map((registration) => {
          const relativeIconPath = registration.icon.replace(/^\/+/, "");
          for (const publicRoot of [WEB_PUBLIC_ROOT, WWW_PUBLIC_ROOT]) {
            expect(
              existsSync(resolve(publicRoot, relativeIconPath)),
              `${registrationName(registration)} icon in ${publicRoot}`,
            ).toBe(true);
          }
          return basename(relativeIconPath);
        }),
      ),
    ].toSorted();
    const iconFiles = readdirSync(AGENT_ICON_ROOT)
      .filter((file) => file.endsWith(".svg"))
      .toSorted();

    expect(iconFiles).toEqual(registeredIcons);
  });
});
