import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { RenderProfiler } from "./components/RenderProfiler.tsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <RenderProfiler id="App">
        <App />
      </RenderProfiler>
    </BrowserRouter>
  </React.StrictMode>,
);
