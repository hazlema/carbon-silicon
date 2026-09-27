import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: false }),
    // The Bun server serves non-immutable files (this file included) with cache-control: no-cache,
    // so a poll always sees the redeployed version.json rather than a cached stale one.
    version: { pollInterval: 60000 },
  },
};
