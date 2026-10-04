import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 5173 is often taken by other local projects; use a dedicated port and fail instead of sharing it.
  server: { host: "127.0.0.1", port: 5190, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        // Keep KaTeX and React out of the app chunk so each stays under the size warning.
        codeSplitting: {
          groups: [
            { name: "katex", test: /node_modules[\\/]katex/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
