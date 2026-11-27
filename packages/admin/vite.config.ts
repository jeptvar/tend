import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  // tendcms copies this folder into its own dist/admin when it builds.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The licences of everything bundled into the admin (PLAN.md §14). It ends up in the
    // published package as dist/admin/THIRD_PARTY_NOTICES.md.
    license: { fileName: "THIRD_PARTY_NOTICES.md" },
    // Pictures stay files of their own. One under 4 KB would otherwise be written into the
    // JavaScript every screen loads first, as text a third bigger, for a screen that uses it.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Everything that isn't the admin itself comes from Tend, so "View site" works here too.
    proxy: { "^/(?!admin)": process.env.TEND_API_URL ?? "http://127.0.0.1:3000" },
  },
});
