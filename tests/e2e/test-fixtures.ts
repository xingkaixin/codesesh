import { expect, test as base, type Page } from "playwright/test";

export function monitorBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page: ${error.stack ?? error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

type BrowserErrorFixtures = {
  browserErrorGate: void;
};

export const test = base.extend<BrowserErrorFixtures>({
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
