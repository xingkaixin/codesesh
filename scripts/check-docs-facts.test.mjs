import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKED_FACT_DOCUMENTS,
  extractMarkedFactRegions,
  findDocumentationFactMismatches,
} from "./check-docs-facts.mjs";

const tempDirs = [];
const coreFacts = {
  cacheSchemaVersion: 21,
  agents: [
    { name: "claudecode", displayName: "Claude Code", sourceKind: "filesystem" },
    { name: "cursor", displayName: "Cursor", sourceKind: "sqlite" },
  ],
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function marked(fact, contents) {
  return `<!-- repo-fact:${fact}:start -->\n${contents}\n<!-- repo-fact:${fact}:end -->`;
}

function fixtureRepo(packageManager = "pnpm@11.20.0", nodeEngine = ">=22.0.0") {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-docs-facts-"));
  tempDirs.push(dir);
  const agentsTable = marked(
    "agents",
    "| Agent | Status |\n|---|---|\n| Claude Code | Supported |\n| Cursor | Supported |",
  );
  const agentsList = marked("agents", "- Claude Code\n- Cursor");
  const node = marked("node-version", "- Node.js 22+");
  const pnpm = marked("pnpm-version", "- pnpm 11.20.0");
  const sourceKinds = marked(
    "agent-source-kinds",
    "- 文件型：Claude Code\n- 单 SQLite 数据库型：Cursor",
  );
  const files = {
    "package.json": JSON.stringify({ packageManager }),
    "packages/cli/package.json": JSON.stringify({ engines: { node: nodeEngine } }),
    "packages/cli/README.md": node,
    "README.md": `${agentsTable}\n${node}\n${pnpm}`,
    "README_CN.md": `${agentsTable}\n${node}\n${pnpm}`,
    "apps/www/public/llms-full.txt": `${agentsList}\n${node}\n${node}\n${pnpm}\n${pnpm}`,
    "docs/scanning-and-caching.md": sourceKinds,
    "docs/architecture.md": sourceKinds,
    "docs/sqlite-storage.md": marked(
      "cache-schema-version",
      "- 当前 schema：`CACHE_SCHEMA_VERSION = 21`",
    ),
  };

  for (const [path, contents] of Object.entries(files)) {
    const fullPath = join(dir, path);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, contents);
  }
  return dir;
}

describe("CS-172: semantic documentation facts", () => {
  it("extracts every region for a repeated fact", () => {
    expect(
      extractMarkedFactRegions(
        `${marked("pnpm-version", "pnpm 11.20.0")}\n${marked("pnpm-version", "pnpm 11.20.0")}`,
        "pnpm-version",
      ),
    ).toHaveLength(2);
  });

  it("accepts documents that match executable facts", () => {
    expect(findDocumentationFactMismatches(fixtureRepo(), coreFacts)).toEqual([]);
  });

  it("reports a schema bump that was not copied to documentation", () => {
    const mismatches = findDocumentationFactMismatches(fixtureRepo(), {
      ...coreFacts,
      cacheSchemaVersion: 22,
    });

    expect(mismatches).toContainEqual({
      document: "docs/sqlite-storage.md",
      fact: "cache-schema-version",
      message: "expected CACHE_SCHEMA_VERSION = 22; documented 21",
    });
  });

  it("reports a newly registered agent in both support and source-kind declarations", () => {
    const mismatches = findDocumentationFactMismatches(fixtureRepo(), {
      ...coreFacts,
      agents: [
        ...coreFacts.agents,
        { name: "fixture", displayName: "Fixture", sourceKind: "filesystem" },
      ],
    });

    expect(mismatches).toHaveLength(5);
    expect(mismatches.every(({ message }) => message.includes('missing ["Fixture"]'))).toBe(true);
  });

  it("reports every marked pnpm copy after packageManager changes", () => {
    const mismatches = findDocumentationFactMismatches(fixtureRepo("pnpm@11.21.0"), coreFacts);
    const pnpmMismatches = mismatches.filter(({ fact }) => fact === "pnpm-version");

    expect(pnpmMismatches).toHaveLength(4);
    expect(pnpmMismatches[0].message).toContain("expected pnpm 11.21.0");
  });

  it("reports every marked Node baseline after engines changes", () => {
    const mismatches = findDocumentationFactMismatches(
      fixtureRepo("pnpm@11.20.0", ">=24.0.0"),
      coreFacts,
    );
    const nodeMismatches = mismatches.filter(({ fact }) => fact === "node-version");

    expect(nodeMismatches).toHaveLength(5);
    expect(nodeMismatches[0].message).toContain("expected Node.js 24.0.0");
  });

  it("requires an explicit marker in every checked document", () => {
    const dir = fixtureRepo();
    writeFileSync(join(dir, "README.md"), marked("agents", "- Claude Code\n- Cursor"));

    expect(findDocumentationFactMismatches(dir, coreFacts)).toContainEqual({
      document: "README.md",
      fact: "pnpm-version",
      message: "missing repo-fact:pnpm-version marker",
    });
  });

  it("covers user, architecture, and AI knowledge documents", () => {
    expect(CHECKED_FACT_DOCUMENTS).toEqual(
      expect.arrayContaining([
        "README.md",
        "README_CN.md",
        "packages/cli/README.md",
        "docs/architecture.md",
        "apps/www/public/llms-full.txt",
      ]),
    );
  });
});
