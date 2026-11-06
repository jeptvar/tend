import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "react-intl";
import { App } from "./App.tsx";
import messages from "./messages/en.json";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// A failed request usually means Tend isn't running, and the screens say so
// straight away rather than leaving someone looking at a spinner.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" defaultLocale="en" messages={messages}>
        <App />
      </IntlProvider>
    </QueryClientProvider>
  </StrictMode>,
);
