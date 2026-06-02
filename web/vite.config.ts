import { defineConfig } from "vite";

// The bridge will serve the built PWA (and tailscale serve fronts it with HTTPS).
// During dev, Vite serves on 127.0.0.1:5173; ws proxying to the bridge is added in PR1/PR3.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
});
