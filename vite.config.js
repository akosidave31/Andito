import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Which build this is, shown in the app's Settings (and the shopper's
// account menu) so it's easy to check that a new APK really got installed.
// GitHub Actions provides the build number (the "#18" on the Actions page)
// and the commit; a build made anywhere else shows as "Local build".
const build = {
  run: process.env.GITHUB_RUN_NUMBER || "",
  commit: (process.env.GITHUB_SHA || "").slice(0, 7),
  date: new Date().toISOString().slice(0, 10),
};

export default defineConfig({
  plugins: [react()],
  // Capacitor loads the built app from a local file:// / capacitor:// origin
  // on Android, not from a server root — relative paths keep asset links
  // working inside the WebView.
  base: "./",
  define: {
    __ANDITO_BUILD__: JSON.stringify(build),
  },
});
