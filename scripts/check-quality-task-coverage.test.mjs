import { describe, expect, it } from "vitest";
import {
  findAstroCoverageGaps,
  findCommandCoverageGaps,
  findManifestTaskGaps,
  findTurboTaskGaps,
  QUALITY_PACKAGES,
  QUALITY_TASKS,
} from "./check-quality-task-coverage.mjs";

describe("CS-173: quality task coverage", () => {
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
