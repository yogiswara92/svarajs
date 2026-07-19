import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The dashboard is served by the SvaraJS standalone runtime (src/dashboard/serve.ts)
// under the '/dashboard' path on the same Express server as the API, not from
// the site root - so built asset URLs must be prefixed with '/dashboard/'.
//
// `npm run dev` here only serves the static SPA - there is no API behind it
// on its own. Run a real backend separately (`svara start`, default port
// 3000) and this dev server proxies /api/* to it, so you get hot-reload on
// the frontend while talking to a live agent. Override the target with
// SVARA_DEV_API if your backend runs on a different port.
const apiTarget = process.env.SVARA_DEV_API || 'http://localhost:3000'

export default defineConfig({
  base: '/dashboard/',
  plugins: [svelte()],
  server: {
    port: 5185,
    open: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'terser'
  }
})
