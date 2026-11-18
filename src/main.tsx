import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter-tight/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./styles/tokens.css";
import "./styles/global.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
