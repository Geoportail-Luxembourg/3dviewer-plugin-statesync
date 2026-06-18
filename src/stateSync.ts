import type { VcsEvent, VcsMap } from '@vcmap/core';
import type { AppState, VcsUiApp } from '@vcmap/ui';
import {
  getFromLocalStorage,
  removeFromLocalStorage,
  setToLocalStorage,
} from '@vcmap/ui';
import { name } from '../package.json';

/** localStorage key, prefixed by the plugin name: `${name}_${STATE_KEY}` */
export const STATE_KEY = 'state';

const PERSIST_THROTTLE_MS = 1000;

// the cached app state is a soft-private member of VcsUiApp, applied module by
// module while modules are loading — the same mechanism as the state URL parameter
/* eslint-disable no-underscore-dangle, @typescript-eslint/naming-convention */
type CachedStateContainer = { _cachedAppState?: AppState };

function hasCachedAppState(app: VcsUiApp): boolean {
  return '_cachedAppState' in (app as unknown as CachedStateContainer);
}

export function getCachedAppState(app: VcsUiApp): AppState | undefined {
  return (app as unknown as CachedStateContainer)._cachedAppState;
}

export function setCachedAppState(app: VcsUiApp, state: AppState): void {
  (app as unknown as CachedStateContainer)._cachedAppState = state;
}
/* eslint-enable no-underscore-dangle, @typescript-eslint/naming-convention */

function isAppState(value: unknown): value is AppState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const state = value as Partial<AppState>;
  return (
    Array.isArray(state.moduleIds) &&
    state.moduleIds.every((id) => typeof id === 'string') &&
    Array.isArray(state.layers) &&
    state.layers.every(
      (layer) =>
        typeof layer === 'object' &&
        layer !== null &&
        typeof layer.name === 'string' &&
        typeof layer.active === 'boolean',
    ) &&
    Array.isArray(state.plugins) &&
    Array.isArray(state.clippingPolygons) &&
    (state.activeMap === undefined || typeof state.activeMap === 'string') &&
    (state.activeObliqueCollection === undefined ||
      typeof state.activeObliqueCollection === 'string') &&
    (state.activeViewpoint === undefined ||
      (typeof state.activeViewpoint === 'object' &&
        state.activeViewpoint !== null))
  );
}

// the active viewpoint is read from the live camera on every getState call.
// It is volatile in two ways: it gets a fresh uuid `name` each call, and its
// floating point values jitter in their last digits frame to frame. Dropping
// the name and rounding the numbers keeps an idle camera serializing
// identically, so a re-render alone does not trigger a write — coordinates to
// ~1cm, angles to ~0.001°.
const COORDINATE_DECIMALS = 7;
const HEIGHT_DECIMALS = 2;
const ANGLE_DECIMALS = 3;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundCoordinate(coordinate: number[]): number[] {
  return coordinate.map((value, index) =>
    roundTo(value, index < 2 ? COORDINATE_DECIMALS : HEIGHT_DECIMALS),
  );
}

/**
 * Returns a copy of the state with the active viewpoint rounded, so an
 * unchanged view yields a stable serialization for change detection.
 */
export function normalizeState(state: AppState): AppState {
  const viewpoint = state.activeViewpoint;
  if (!viewpoint) {
    return state;
  }
  const normalizedViewpoint = { ...viewpoint };
  // a camera-derived viewpoint gets a fresh uuid name on every read
  delete normalizedViewpoint.name;
  if (Array.isArray(viewpoint.cameraPosition)) {
    normalizedViewpoint.cameraPosition = roundCoordinate(
      viewpoint.cameraPosition,
    );
  }
  if (Array.isArray(viewpoint.groundPosition)) {
    normalizedViewpoint.groundPosition = roundCoordinate(
      viewpoint.groundPosition,
    );
  }
  if (typeof viewpoint.distance === 'number') {
    normalizedViewpoint.distance = roundTo(viewpoint.distance, HEIGHT_DECIMALS);
  }
  if (typeof viewpoint.heading === 'number') {
    normalizedViewpoint.heading = roundTo(viewpoint.heading, ANGLE_DECIMALS);
  }
  if (typeof viewpoint.pitch === 'number') {
    normalizedViewpoint.pitch = roundTo(viewpoint.pitch, ANGLE_DECIMALS);
  }
  if (typeof viewpoint.roll === 'number') {
    normalizedViewpoint.roll = roundTo(viewpoint.roll, ANGLE_DECIMALS);
  }
  return { ...state, activeViewpoint: normalizedViewpoint };
}

export function readStoredState(): AppState | undefined {
  const json = getFromLocalStorage(name, STATE_KEY);
  if (!json) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (isAppState(parsed)) {
      return parsed;
    }
  } catch {
    // invalid JSON, cleaned up below
  }
  removeFromLocalStorage(name, STATE_KEY);
  return undefined;
}

/**
 * Restores the app state persisted in a previous session by injecting it into
 * the app's cached state, which the app applies module by module — the same
 * mechanism used for the `state` URL parameter. The URL keeps highest
 * priority: nothing is restored when a `state` URL parameter is present.
 * Must be called synchronously in the plugin's `initialize`, before any module
 * the state applies to has finished loading.
 */
export function restoreStateFromLocalStorage(app: VcsUiApp): void {
  if (new URL(window.location.href).searchParams.has('state')) {
    return;
  }
  const stored = readStoredState();
  if (!stored) {
    return;
  }
  if (!hasCachedAppState(app)) {
    // eslint-disable-next-line no-console
    console.warn(
      `${name}: VcsUiApp no longer exposes _cachedAppState, state restore is disabled.`,
    );
    return;
  }
  if (getCachedAppState(app)?.moduleIds.length) {
    // a state is already cached (e.g. from the URL), never clobber it
    return;
  }
  setCachedAppState(app, stored);
}

/**
 * Continuously persists the app state to the localStorage, throttled to one
 * write per second. Returns a dispose function removing all listeners.
 */
export function startStateSync(app: VcsUiApp): () => void {
  let lastWritten: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function persist(): void {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      app
        .getState(true)
        .then((state) => {
          const json = JSON.stringify(normalizeState(state));
          if (json !== lastWritten) {
            setToLocalStorage(name, STATE_KEY, json);
            lastWritten = json;
          }
        })
        .catch(() => {
          // getState throws as long as no map is active yet
        });
    }, PERSIST_THROTTLE_MS);
  }

  let postRenderListener: (() => void) | undefined;
  function bindPostRender(map: VcsMap | null): void {
    postRenderListener?.();
    postRenderListener = map?.postRender.addEventListener(persist);
  }
  bindPostRender(app.maps.activeMap);

  // typed as a plain OverrideCollection on VcsApp, but the underlying
  // ClippingPolygonObjectCollection raises stateChanged
  const clippingPolygonsStateChanged = (
    app.clippingPolygons as unknown as {
      stateChanged?: VcsEvent<unknown>;
    }
  ).stateChanged;

  const listeners = [
    app.layers.stateChanged.addEventListener(persist),
    clippingPolygonsStateChanged?.addEventListener(persist),
    app.maps.mapActivated.addEventListener((map) => {
      bindPostRender(map);
      persist();
    }),
  ].filter((listener) => !!listener);

  return () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    bindPostRender(null);
    listeners.forEach((unlisten) => {
      unlisten();
    });
  };
}
