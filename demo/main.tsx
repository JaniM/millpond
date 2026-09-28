import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DbProvider } from "../src/react";
import { App } from "./App";
import { db } from "./db";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <DbProvider db={db}>
      <App />
    </DbProvider>
  </StrictMode>,
);
