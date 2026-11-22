import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command }) => ({
    plugins: [react()],
    server: {
        host: "0.0.0.0",
        port: 5173,
        strictPort: false,
        // The preview proxy forwards the sandbox host; never block it via origin checks.
        allowedHosts: true,
    },
    preview: { host: "0.0.0.0", port: 4173, allowedHosts: true },
    worker: { format: "es" },
    // MapLibre 6 ships its tile worker as a sibling module. Vite 8's dependency pre-bundler
    // rewrites the import inside `maplibre-gl.js`, and the worker then fails to load ("Check that
    // the worker URL is correct"). Excluding it from pre-bundling keeps the worker URL intact.
    optimizeDeps: { exclude: ["maplibre-gl"] },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1600 },
    test: {
        environment: "node",
        include: ["src/test/**/*.test.ts"],
        // The 2-D shallow-flow cases route a real breach hydrograph over a 161 x 161 grid.
        testTimeout: 120_000,
    },
    // A static build served from a sub-path needs relative asset URLs.
    base: command === "build" ? "./" : "/",
}));
