# SvaraJS Dashboard

The operator dashboard for the [standalone runtime](../README.md#standalone-runtime--dashboard) (`svara start`). This is a pure frontend (Svelte + Vite) that talks to `/api/*` on the SvaraJS Express server - it has no backend of its own and cannot run standalone.

## Running it for real

```bash
npm run build          # from this directory, or `npm run build:dashboard` from the package root
cd ..
svara start            # serves this build at http://localhost:3000/dashboard
```

## Developing with hot-reload

`npm run dev` here only serves the static SPA - every `/api/*` call will fail ("failed to load") unless a real backend is also running, since there's nothing listening on the Vite dev port to answer them. Run both:

```bash
# Terminal 1 - a real backend, e.g. in a scaffolded standalone project
svara start --port 3000

# Terminal 2 - this dashboard, with hot-reload, proxying /api/* to the backend above
cd dashboard
npm run dev
# → http://localhost:5185/dashboard/
```

If your backend runs on a different port, point the proxy at it:

```bash
SVARA_DEV_API=http://localhost:4000 npm run dev
```

## Build output

`npm run build` outputs to `dist/`, with `base: '/dashboard/'` baked in (see `vite.config.js`) so asset URLs resolve correctly once served under that sub-path by `src/dashboard/serve.ts`. `dist/` is gitignored but shipped in the published npm package (see the root `package.json`'s `files` field).
