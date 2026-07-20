import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RenderProfiler } from "./components/RenderProfiler.tsx";
import { initializeRemoteAccess } from "./lib/api.ts";
import { queryClient } from "./lib/query-client.ts";
import { AppRouter } from "./router.tsx";
import "./index.css";

initializeRemoteAccess();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RenderProfiler id="App">
        <AppRouter />
      </RenderProfiler>
    </QueryClientProvider>
  </React.StrictMode>,
);
