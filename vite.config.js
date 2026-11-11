import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  server: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/rtc": { target: "ws://127.0.0.1:7880", ws: true },
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
});
