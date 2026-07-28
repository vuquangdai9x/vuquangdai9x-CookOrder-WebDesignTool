import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    port: 5173,
    proxy: {
      // Google Sheets CSV export doesn't send CORS headers, so the dev server
      // proxies it. "/gsheet/..." -> "https://docs.google.com/...".
      "/gsheet": {
        target: "https://docs.google.com",
        changeOrigin: true,
        followRedirects: true,
        // Machines behind SSL-inspecting proxies fail Node's cert check; this
        // is a local dev tool reading public sheet data, so skip verification.
        secure: false,
        rewrite: (path) => path.replace(/^\/gsheet/, ""),
      },
    },
  },
});
