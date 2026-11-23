import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RenderProfiler } from "./components/RenderProfiler.tsx";
import { queryClient } from "./lib/query-client.ts";
import { AppRouter } from "./router.tsx";
import { ScanStatusProvider } from "./hooks/useScanStatus.tsx";
import { getLocale } from "./i18n/language.ts";
import { loadLocaleCatalog } from "./i18n/translate.ts";
import "./styles/fonts.css";
import "./index.css";

function mountApp() {
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
}

const initialLocale = getLocale();
if (initialLocale === "en") {
  mountApp();
} else {
  void loadLocaleCatalog(initialLocale).finally(mountApp);
}
