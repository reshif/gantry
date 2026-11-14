import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles";
import App from "./App";
import { StepUpPopupDone } from "./ui/stepup";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");
const popup = new URLSearchParams(window.location.search).get("step_up_popup");
createRoot(el).render(
  <StrictMode>
    {popup ? <StepUpPopupDone ok={popup === "ok"} msg={new URLSearchParams(window.location.search).get("msg") ?? ""} /> : <App />}
  </StrictMode>,
);
