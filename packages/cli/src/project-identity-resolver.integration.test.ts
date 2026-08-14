import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThreadProjectIdentityResolver } from "./project-identity-resolver.js";

const slowWorkerUrl = new URL("./project-identity-resolver.slow-worker.mjs", import.meta.url);

describe("ThreadProjectIdentityResolver integration", () => {
  it.skipIf(process.platform === "win32")(
    "keeps timers responsive while a real worker waits on slow git",
    async () => {
      const fixtureDir = mkdtempSync(join(tmpdir(), "codesesh-slow-git-"));
      const binDir = join(fixtureDir, "bin");
      const gitPath = join(binDir, "git");
      const previousPath = process.env.PATH;
      mkdirSync(binDir);
      writeFileSync(gitPath, "#!/bin/sh\nsleep 0.15\nexit 1\n");
      chmodSync(gitPath, 0o755);
      process.env.PATH = [binDir, previousPath].filter(Boolean).join(delimiter);

      const resolver = new ThreadProjectIdentityResolver(slowWorkerUrl, 1);
      try {
        let timerFired = false;
        let resolutionSettled = false;
        const pending = resolver.resolve(fixtureDir);
        void pending.then(
          () => {
            resolutionSettled = true;
          },
          () => {
            resolutionSettled = true;
          },
        );

        await new Promise<void>((resolve) => {
          setTimeout(() => {
            timerFired = true;
            resolve();
          }, 20);
        });

        expect(timerFired).toBe(true);
        expect(resolutionSettled).toBe(false);
        await expect(pending).resolves.toMatchObject({
          identity: { kind: "path", key: fixtureDir },
        });
      } finally {
        await resolver.shutdown();
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    },
  );
});
