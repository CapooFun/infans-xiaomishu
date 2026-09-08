#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFrontendAtomically } from "../src/server/workbench-frontend-refresh.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await buildFrontendAtomically({ appDir, distDir: path.join(appDir, "dist") });
