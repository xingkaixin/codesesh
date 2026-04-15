#!/usr/bin/env node
/**
 * Post-build script to copy web dist into CLI package
 * This ensures the CLI can serve the web UI as static files
 */
import { existsSync, cpSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "../../..");
const cliDir = resolve(__dirname, "..");

const webDistSource = resolve(rootDir, "apps", "web", "dist");
const webDistTarget = resolve(cliDir, "dist/web");

if (!existsSync(webDistSource)) {
  console.warn("⚠️  Web dist not found at:", webDistSource);
  console.warn("   Run 'pnpm --filter @codesesh/web build' first");
  process.exit(0);
}

// Ensure target directory exists
try {
  mkdirSync(dirname(webDistTarget), { recursive: true });
  cpSync(webDistSource, webDistTarget, { recursive: true, force: true });
  console.log("✓ Copied web dist to:", webDistTarget);
} catch (err) {
  console.error("✗ Failed to copy web dist:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
