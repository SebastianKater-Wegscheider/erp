import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || "/",
  server: {
    port: 5174,
  },
  preview: {
    host: true,
    port: 5174,
    allowedHosts: ["kater-lan", "kater-lan.fritz.box", "192.168.178.72"],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
