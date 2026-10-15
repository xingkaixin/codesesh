import { satteri } from "@astrojs/markdown-satteri";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { terminalBlocks } from "./src/markdown/terminal-blocks";

export default defineConfig({
  output: "static",
  site: "https://codesesh.xingkaixin.me",
  trailingSlash: "always",
  build: {
    inlineStylesheets: "always",
  },
  markdown: {
    syntaxHighlight: false,
    processor: satteri({ hastPlugins: [terminalBlocks] }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
