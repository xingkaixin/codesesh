import { readFile } from "node:fs/promises";
import { expect, test as base, type BrowserContext, type Page } from "playwright/test";

const ACCESS_TOKEN_STORAGE_KEY = "codesesh:remote-access-token";

async function readServerAccessToken(): Promise<string> {
  const path = process.env.CODESESH_E2E_STARTUP_URL_PATH;
  if (!path) throw new Error("Missing CODESESH_E2E_STARTUP_URL_PATH");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const token = new URL(await readFile(path, "utf8")).searchParams.get("access_token");
      if (token) return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("Timed out waiting for the CodeSesh startup access token");
}

export async function configureApiAccess(context: BrowserContext): Promise<void> {
  const token = await readServerAccessToken();
  await context.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
  await context.addInitScript(({ key, value }) => window.sessionStorage.setItem(key, value), {
    key: ACCESS_TOKEN_STORAGE_KEY,
    value: token,
  });
}

export function monitorBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

type BrowserErrorFixtures = {
  apiAccess: void;
  browserErrorGate: void;
};

export const test = base.extend<BrowserErrorFixtures>({
  apiAccess: [
    async ({ context }, use, testInfo) => {
      if (testInfo.project.name === "web-chromium") {
        await configureApiAccess(context);
      }
      await use();
    },
    { auto: true },
  ],
  browserErrorGate: [
    async ({ page }, use) => {
      const errors = monitorBrowserErrors(page);
      await use();
      expect(errors, "unexpected browser errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
