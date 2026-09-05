import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCachedSessionHeads } from "@codesesh/core/runtime/discovery";

const root = fileURLToPath(new URL("..", import.meta.url));
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "all-time-benchmark-"));
const now = process.argv[2] === undefined ? Date.now() : Number(process.argv[2]);
if (!Number.isFinite(now)) throw new Error("Expected an optional epoch timestamp in milliseconds");

try {
  const entry = join(work, "handlers.ts");
  writeFileSync(
    entry,
    ["dashboard-handler", "catalog-handlers"]
      .map(
        (name) =>
          `export * from ${JSON.stringify(join(root, "packages/cli/src/api", `${name}.js`))};`,
      )
      .join("\n"),
  );
  const build = spawnSync(
    "pnpm",
    [
      "--filter",
      "codesesh",
      "exec",
      "tsup",
      entry,
      "--format",
      "esm",
      "--out-dir",
      join(work, "dist"),
      "--silent",
    ],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (build.status !== 0) throw new Error("Could not build API benchmark entry");
  const { handleGetDashboard, handleGetProjects } = await import(
    pathToFileURL(join(work, "dist", "handlers.js")).href
  );
  const require = createRequire(join(root, "packages/core/package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(join(homedir(), ".cache/codesesh/codesesh.db"), { readonly: true });
  const references = db
    .prepare(
      "SELECT agent_name AS agentName, session_id AS sessionId FROM sessions WHERE publication_id IS NULL",
    )
    .all();
  db.close();
  const heads = loadCachedSessionHeads(references).map(({ session }) => session);
  Date.now = () => now;
  const context = (query) => ({
    req: { query: (key) => query[key], url: `http://localhost/api?${new URLSearchParams(query)}` },
    json: (value) => value,
  });
  for (let iteration = 0; iteration < 5; iteration++) {
    const sessions = [...heads];
    const byAgent = Object.groupBy(sessions, (session) => session.reference.agentName);
    const source = { getSnapshot: () => ({ sessions, byAgent }) };
    const started = performance.now();
    const dashboard = handleGetDashboard(context({ days: "0" }), source);
    const middle = performance.now();
    const { nextCursor: _cursor, ...projects } = handleGetProjects(
      context({ from: new Date(0).toISOString(), limit: "100" }),
      source,
    );
    const finished = performance.now();
    const digest = createHash("sha256")
      .update(JSON.stringify({ dashboard, projects }))
      .digest("hex");
    console.log(
      JSON.stringify({
        iteration,
        now,
        sessions: sessions.length,
        dashboard_ms: middle - started,
        projects_ms: finished - middle,
        total_ms: finished - started,
        digest,
      }),
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
