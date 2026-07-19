import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  root: resolve(root, "pages"),
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: resolve(root, "dist/pages"),
    emptyOutDir: true,
  },
});
