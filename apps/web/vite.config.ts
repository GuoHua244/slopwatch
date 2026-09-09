import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dashboard talks to the Server same-origin when embedded; in dev the
// Vite dev server proxies the read-only API and the admin plane to the
// locally running Server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/sessions": "http://localhost:8787",
      "/healthz": "http://localhost:8787",
      "/admin": "http://localhost:8787",
    },
  },
});
