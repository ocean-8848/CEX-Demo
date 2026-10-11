import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = process.env.NODE_ENV !== "development";

await build({
  entryPoints: [path.join(appRoot, "client/main.tsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: path.join(appRoot, "public/app.js"),
  jsx: "automatic",
  minify: production,
  // Source maps keep the bundled console readable in DevTools for learners.
  sourcemap: "linked",
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development")
  },
  logLevel: "info"
});

// Shared design tokens / primitives from @web3-cex/web-ui, served as /base.css.
const require = createRequire(import.meta.url);
await copyFile(require.resolve("@web3-cex/web-ui/base.css"), path.join(appRoot, "public/base.css"));
