import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  site: "https://codesesh.xingkaixin.me",
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss()],
  },
});
