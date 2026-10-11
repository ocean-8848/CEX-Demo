import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(currentFilePath), "..");
const publicDir = path.join(appRoot, "public");
const distDir = path.join(appRoot, "dist");
const distPublicDir = path.join(distDir, "public");

await mkdir(distDir, { recursive: true });
await cp(publicDir, distPublicDir, { recursive: true, force: true });
