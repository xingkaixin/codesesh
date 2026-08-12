import { describe, expect, it } from "vitest";
import {
  findAstroCoverageGaps,
  findCommandCoverageGaps,
  findManifestTaskGaps,
  findTurboTaskGaps,
  QUALITY_PACKAGES,
  QUALITY_TASKS,
  ROOT_TASK_REQUIREMENTS,
  SCRIPT_PACKAGE_TASK_REQUIREMENTS,
} from "./check-quality-task-coverage.mjs";
import { getPnpmInvocation } from "./lib/pnpm-process.mjs";

describe("CS-173: quality task coverage", () => {
  it("runs pnpm command shims through the Windows shell", () => {
    expect(getPnpmInvocation("win32")).toEqual({ executable: "pnpm.cmd", shell: true });
    expect(getPnpmInvocation("linux")).toEqual({ executable: "pnpm", shell: false });
  });

  it("requires every quality script in every critical package", () => {
    const complete = QUALITY_PACKAGES.map(({ name }) => ({
      name,
      scripts: Object.fromEntries(QUALITY_TASKS.map((task) => [task, `tool ${task}`])),
    }));

    expect(findManifestTaskGaps(complete)).toEqual([]);
    expect(findManifestTaskGaps([{ name: "@codesesh/www", scripts: { lint: "eslint" } }])).toEqual([
      "@codesesh/www#lint:fix has no package script",
      "@codesesh/www#format has no package script",
      "@codesesh/www#format:check has no package script",
    ]);
  });

  it("rejects NONEXISTENT and missing Turbo tasks", () => {
    const dryRun = {
      tasks: [
        { taskId: "@codesesh/core#lint", command: "oxlint src" },
        { taskId: "@codesesh/www#lint", command: "<NONEXISTENT>" },
      ],
    };

    expect(
      findTurboTaskGaps(dryRun, ["@codesesh/core", "@codesesh/www", "codesesh"], "lint"),
    ).toEqual(["@codesesh/www#lint is <NONEXISTENT>", "codesesh#lint is missing"]);
  });

  it("keeps both standalone and Astro-aware tools in www commands", () => {
    const scripts = {
      lint: 'oxlint src && eslint "src/**/*.astro"',
      "lint:fix": 'oxlint src --fix && eslint "src/**/*.astro" --fix',
      format: 'oxfmt --write src && prettier --write "src/**/*.astro"',
      "format:check": 'oxfmt --check src && prettier --check "src/**/*.astro"',
    };

    expect(findCommandCoverageGaps(scripts)).toEqual([]);
    expect(findCommandCoverageGaps({ ...scripts, lint: "oxlint src" })).toEqual([
      "@codesesh/www#lint misses eslint, src/**/*.astro",
    ]);
  });

  it("covers every script file below each package root", () => {
    const scripts = {
      lint: "oxlint .",
      "lint:fix": "oxlint . --fix",
      format: 'oxfmt --write "**/*.{js,mjs,cjs,ts,tsx}"',
      "format:check": 'oxfmt --check "**/*.{js,mjs,cjs,ts,tsx}"',
    };

    expect(
      findCommandCoverageGaps(scripts, SCRIPT_PACKAGE_TASK_REQUIREMENTS, "@codesesh/web"),
    ).toEqual([]);
    expect(
      findCommandCoverageGaps(
        { ...scripts, lint: "oxlint src" },
        SCRIPT_PACKAGE_TASK_REQUIREMENTS,
        "@codesesh/web",
      ),
    ).toEqual(["@codesesh/web#lint misses oxlint ."]);
    expect(
      findCommandCoverageGaps(
        { ...scripts, "format:check": "oxfmt --check src" },
        SCRIPT_PACKAGE_TASK_REQUIREMENTS,
        "@codesesh/web",
      ),
    ).toEqual(["@codesesh/web#format:check misses **/*.{js,mjs,cjs,ts,tsx}"]);
  });

  it("keeps root sources in every repository quality command", () => {
    const scripts = {
      lint: "pnpm lint:root && turbo run lint",
      "lint:root": "oxlint scripts tests playwright.config.ts vitest.config.ts",
      "lint:fix": "pnpm lint:fix:root && turbo run lint:fix",
      "lint:fix:root": "oxlint scripts tests playwright.config.ts vitest.config.ts --fix",
      format: "pnpm format:root && turbo run format",
      "format:root":
        'oxfmt --write "scripts/**/*.{js,mjs,cjs,ts,tsx}" "tests/**/*.{js,mjs,cjs,ts,tsx}" playwright.config.ts vitest.config.ts',
      "format:check": "pnpm format:check:root && turbo run format:check",
      "format:check:root":
        'oxfmt --check "scripts/**/*.{js,mjs,cjs,ts,tsx}" "tests/**/*.{js,mjs,cjs,ts,tsx}" playwright.config.ts vitest.config.ts',
    };

    expect(findCommandCoverageGaps(scripts, ROOT_TASK_REQUIREMENTS, "codesesh-monorepo")).toEqual(
      [],
    );
    expect(
      findCommandCoverageGaps(
        { ...scripts, "lint:root": "oxlint scripts playwright.config.ts vitest.config.ts" },
        ROOT_TASK_REQUIREMENTS,
        "codesesh-monorepo",
      ),
    ).toEqual(["codesesh-monorepo#lint:root misses tests"]);
    expect(
      findCommandCoverageGaps(
        { ...scripts, "format:check:root": "oxfmt --check scripts playwright.config.ts" },
        ROOT_TASK_REQUIREMENTS,
        "codesesh-monorepo",
      ),
    ).toEqual([
      "codesesh-monorepo#format:check:root misses scripts/**/*.{js,mjs,cjs,ts,tsx}, tests/**/*.{js,mjs,cjs,ts,tsx}, vitest.config.ts",
    ]);
  });

  it("proves both tools recognize every Astro source", () => {
    const files = ["src/components/ProductDemo.astro", "src/pages/index.astro"];

    expect(
      findAstroCoverageGaps(files, files, { ignored: false, inferredParser: "astro" }),
    ).toEqual([]);
    expect(
      findAstroCoverageGaps(files, [files[1]], { ignored: true, inferredParser: null }),
    ).toEqual([
      "ESLint missed Astro files: src/components/ProductDemo.astro",
      "Prettier ignores ProductDemo.astro",
      "Prettier selected no parser for ProductDemo.astro",
    ]);
  });
});
