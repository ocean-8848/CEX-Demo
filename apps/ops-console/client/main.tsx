import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Ops console root container is missing");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
