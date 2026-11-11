import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

export default defineConfig({
  root: "client",
  server: {
    host: "0.0.0.0",
    port: 4175,
    strictPort: true,
    https: {
      key: readFileSync(new URL("./certs/lan-key.pem", import.meta.url)),
      cert: readFileSync(new URL("./certs/lan.pem", import.meta.url)),
    },
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/rtc": { target: "ws://127.0.0.1:7880", ws: true },
    },
  },
});
