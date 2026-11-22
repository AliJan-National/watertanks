import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const docsDir = path.resolve(rootDir, "docs");

// 1. Copy docs/assets to root assets
const docsAssets = path.resolve(docsDir, "assets");
const rootAssets = path.resolve(rootDir, "assets");

if (fs.existsSync(docsAssets)) {
  fs.cpSync(docsAssets, rootAssets, { recursive: true });
}

// Ensure maplibre worker is present in both root and docs assets
const maplibreWorker = path.resolve(rootDir, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
if (fs.existsSync(maplibreWorker)) {
  fs.copyFileSync(maplibreWorker, path.resolve(rootAssets, "maplibre-gl-worker.mjs"));
  fs.copyFileSync(maplibreWorker, path.resolve(docsAssets, "maplibre-gl-worker.mjs"));
}

// 2. Copy docs/index.html to root index.html, stripping any fallback redirect
const docsIndex = path.resolve(docsDir, "index.html");
const rootIndex = path.resolve(rootDir, "index.html");

if (fs.existsSync(docsIndex)) {
  let html = fs.readFileSync(docsIndex, "utf8");
  // Remove any obsolete fallback redirect scripts if present
  html = html.replace(/<script>\s*\/\/ Fallback:[\s\S]*?<\/script>/, "");
  fs.writeFileSync(rootIndex, html, "utf8");
  fs.writeFileSync(docsIndex, html, "utf8");
}

console.log("Synchronized production build to repository root for root GitHub Pages deployment.");
