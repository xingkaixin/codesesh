import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Read version from package.json
const pkg = await import("./package.json", { with: { type: "json" } });

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // No manual chunk map: naming chunks does not make a static dependency
    // async, and pinning vendors into shared chunks pulls them into the entry
    // as soon as one member is reachable synchronously. The dynamic imports in
    // AppRouteContent define the boundaries instead.
    rolldownOptions: {
      output: {
        codeSplitting: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.default.version),
  },
});
