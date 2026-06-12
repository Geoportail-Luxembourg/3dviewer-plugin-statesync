# @geoportallux/lux-3dviewer-plugin-statesync

> Part of the [VC Map Project](https://github.com/virtualcitySYSTEMS/map-ui)

Persists the current VC Map application state (active map, viewpoint, layer
activation and styles, oblique collection, clipping polygons, plugin states) to
the browser's localStorage and restores it on the next visit.

## How it works

- While the app is running, the state returned by `app.getState(true)` (the
  same state used for sharable `?state=` URLs) is written to localStorage under
  the key `@geoportallux/lux-3dviewer-plugin-statesync_state`, throttled to one
  write per second.
- On startup, the stored state is injected into the app's cached state in the
  plugin's `initialize` hook and applied by the app itself, module by module —
  the same mechanism used for the `state` URL parameter.
- The URL keeps the highest priority: when a `state` URL parameter is present,
  nothing is restored from localStorage.
- Invalid or corrupt stored states are discarded; stale layer or map names are
  skipped by the app's own guards.

## Configuration

The plugin has no configuration options. Register it in the `plugins` array of
the VC Map app configuration:

```json
{
  "plugins": [{ "name": "@geoportallux/lux-3dviewer-plugin-statesync" }]
}
```

List it **before** other plugins, so plugins parsed later can receive their
restored state via `initialize(app, state)`.

## Development

```bash
npm start          # dev server
npm run build      # build plugin
npm test           # run tests with Vitest
npm run lint       # ESLint + Prettier check
npm run type-check # TypeScript type check
```
