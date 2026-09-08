import { randomUUID } from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { workbenchDataPlugin } from "./src/server/workbench-data-plugin.mjs";

const frontendBuildId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

const frontendBuildMetaPlugin = {
  name: "infans-frontend-build-id",
  apply: "build" as const,
  transformIndexHtml() {
    return [{
      tag: "meta",
      attrs: { name: "infans-frontend-build", content: frontendBuildId },
      injectTo: "head" as const,
    }];
  },
};

export default defineConfig({
  build: {
    manifest: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "motion-runtime",
              test: /node_modules[\\/](?:motion|motion-dom|motion-utils)[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    allowedHosts: ["mailbox.example.invalid", "dev.example.invalid"],
    watch: { usePolling: process.env.CODEX_SANDBOX === "seatbelt" },
  },
  preview: { host: "127.0.0.1", port: 4174, strictPort: true },
  plugins: [react(), frontendBuildMetaPlugin, workbenchDataPlugin()],
});
