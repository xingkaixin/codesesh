import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { RenderProfiler } from "./components/RenderProfiler.tsx";
import { initializeRemoteAccess } from "./lib/api.ts";
import { queryClient } from "./lib/query-client.ts";
import "./index.css";

initializeRemoteAccess();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RenderProfiler id="App">
          <App />
        </RenderProfiler>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
