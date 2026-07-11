import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { RenderProfiler } from "./components/RenderProfiler.tsx";
import { initializeRemoteAccess } from "./lib/api.ts";
import "./index.css";

initializeRemoteAccess();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <RenderProfiler id="App">
        <App />
      </RenderProfiler>
    </BrowserRouter>
  </React.StrictMode>,
);
