import { createRoot } from "react-dom/client";
import "./globals.css";
import { LookupApp } from "./lookup-app";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

createRoot(root).render(<LookupApp />);
