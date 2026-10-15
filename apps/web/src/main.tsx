import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RenderProfiler } from "./components/RenderProfiler.tsx";
import { queryClient } from "./lib/query-client.ts";
import { AppRouter } from "./router.tsx";
import { ScanStatusProvider } from "./hooks/useScanStatus.tsx";
import "@fontsource-variable/montserrat";
import "@fontsource/ibm-plex-mono/300.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ScanStatusProvider>
        <RenderProfiler id="App">
          <AppRouter />
        </RenderProfiler>
      </ScanStatusProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
