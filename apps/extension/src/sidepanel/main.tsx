import { VILLANOVA_BRIGHTSPACE_ORIGIN } from "@nova-agent/brightspace";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createChromeHost } from "../platform/chromeHost";
import { createNovaDb } from "../storage/novaDb";
import { App } from "./App";
import "./styles.css";

const db = createNovaDb();
const host = createChromeHost(VILLANOVA_BRIGHTSPACE_ORIGIN);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App db={db} host={host} />
  </StrictMode>,
);
