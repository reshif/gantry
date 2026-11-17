import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles";
import App from "./App";
import { StepUpPopupDone } from "./ui/stepup";
import { AppErrorBoundary } from "./lib/errors/AppErrorBoundary";
import { installGlobalErrorReporter } from "./lib/errors/reporter";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");
const popup = new URLSearchParams(window.location.search).get("step_up_popup");
installGlobalErrorReporter();
createRoot(el).render(
  <StrictMode>
    <AppErrorBoundary level="root">
      {popup ? <StepUpPopupDone ok={popup === "ok"} msg={new URLSearchParams(window.location.search).get("msg") ?? ""} /> : <App />}
    </AppErrorBoundary>
  </StrictMode>,
);
