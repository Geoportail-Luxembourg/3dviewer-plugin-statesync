# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Dev server
npm run build          # Build plugin
npm run lint           # ESLint + Prettier check
npm run format         # Apply Prettier + ESLint fixes
npm test               # Run unit tests (Vitest)
npm run coverage       # Tests with coverage
npm run type-check     # TypeScript type check (vue-tsc --noEmit)
```

Run a single test file:
```bash
npx vitest run tests/stateSync.spec.ts
```

## Architecture

This is a **VC Map plugin** (`@vcmap/core` + `@vcmap/ui`) that persists 3D viewer state to `localStorage` and restores it on page load.

**`src/index.ts`** — Plugin entry point implementing the `VcsPlugin` interface. Calls `restoreStateFromLocalStorage` then `clearStateUrlParam` during `initialize`, starts sync on `onVcsAppMounted`, and tears down on `destroy`.

**`src/stateSync.ts`** — All logic lives here:

- **`restoreStateFromLocalStorage(app)`** — Seeds `app._cachedAppState` from `localStorage` at startup, skipped when a `?state=` URL param is present (URL takes priority).
- **`clearStateUrlParam()`** — Strips the `?state=` param from the URL (via `history.replaceState`) after the app has consumed it. Must run after `restoreStateFromLocalStorage`, which depends on the param to detect URL precedence.
- **`startStateSync(app)`** — Subscribes to layer/clipping polygon state changes, map activation events, and `postRender` for camera movement. Throttles writes to 1 per second. Returns a dispose function.

### Key design decisions

- **`_cachedAppState`** (soft-private on `VcsUiApp`) is the insertion point — the plugin writes into this internal cache so `getState()` produces the right initial state without triggering UI changes.
- **Module reload preservation** (`moduleRemoved` event) — re-seeds the cache after login/logout cycles remove and re-add layers, so absent entries aren't dropped from persisted state.
- **Viewpoint normalization** — floats are rounded before serialization to suppress sub-centimeter jitter (7 decimals for coords, 2 for heights, 3 for angles). Volatile UUID names are stripped.
- **Change detection** — compares JSON-serialized state strings; only writes when something actually changed.
- **URL state is consume-then-clear** — a `?state=` param takes priority on the load that carries it, then the param is removed so subsequent reloads restore from `localStorage` (with in-session changes) rather than re-applying the shared URL state.

### Test environment

Tests use `jsdom` + `jest-canvas-mock` + a `ResizeObserver` polyfill (see `tests/setup.js`). Vitest fake timers are used extensively to control throttle timing. The `forks` pool is required for Cesium compatibility.
