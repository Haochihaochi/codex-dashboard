import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [
    {
      name: 'local-development-csp',
      apply: 'serve',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]+>/, ''),
      },
    },
    react(),
  ],
  base: './',
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
});
