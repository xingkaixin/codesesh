import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { createFixture, REFERENCE, startServer, stop } from "./harness.mjs";

test("existing React session view renders a Rust response", { timeout: 30_000 }, async () => {
  const fixture = createFixture();
  let server;
  let browser;
  try {
    server = await startServer(fixture, [
      resolve(`target/release/codesesh${process.platform === "win32" ? ".exe" : ""}`),
    ]);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);

    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const startup = server.output().stdout.match(/http:\/\/\S+/)[0];
    const url = new URL(startup);
    url.pathname = `/codex/${REFERENCE.sessionId}`;
    await page.goto(url.href);
    await page
      .getByRole("heading", { level: 1, name: "Migration fixture 中文 🔎" })
      .waitFor()
      .catch(async (error) => {
        console.error(await page.locator("body").innerText(), errors);
        throw error;
      });
    await page
      .getByText("A deterministic searchable reply: migration-needle.", { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await stop(server);
    fixture.dispose();
  }
});
