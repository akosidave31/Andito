import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Capacitor loads the built app from a local file:// / capacitor:// origin
  // on Android, not from a server root — relative paths keep asset links
  // working inside the WebView.
  base: "./",
});
