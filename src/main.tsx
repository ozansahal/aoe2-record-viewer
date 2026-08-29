import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { BrowserShell } from "./platform/BrowserShell";
import { ElectronShell } from "./platform/ElectronShell";
import "./styles/global.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

/* The one place the two hosts are told apart. The preload bridge is injected
   before any of this runs, so its presence is settled by now and the choice is
   made once rather than re-tested from inside the tree. */
const bridge = window.aoe2;

createRoot(root).render(
  <StrictMode>
    {bridge ? <ElectronShell bridge={bridge} /> : <BrowserShell />}
  </StrictMode>,
);
