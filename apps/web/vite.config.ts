import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const target = process.env.CS_SERVER ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/llms.txt': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
});
