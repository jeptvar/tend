import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { App } from "./App.tsx";
import messages from "./messages/en.json";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <IntlProvider locale="en" defaultLocale="en" messages={messages}>
      <App />
    </IntlProvider>
  </StrictMode>,
);
