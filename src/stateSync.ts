import type {
  VcsEvent,
  VcsMap,
  VcsModule,
  ViewpointOptions,
} from '@vcmap/core';
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
 * Returns a copy of the viewpoint without its volatile uuid name and with its
 * numbers rounded, so an unchanged view yields a stable serialization.
 */
export function normalizeViewpoint(
  viewpoint: ViewpointOptions,
): ViewpointOptions {
  const normalized = { ...viewpoint };
  // a camera-derived viewpoint gets a fresh uuid name on every read
  delete normalized.name;
  if (Array.isArray(viewpoint.cameraPosition)) {
    normalized.cameraPosition = roundCoordinate(viewpoint.cameraPosition);
  }
  if (Array.isArray(viewpoint.groundPosition)) {
    normalized.groundPosition = roundCoordinate(viewpoint.groundPosition);
  }
  if (typeof viewpoint.distance === 'number') {
    normalized.distance = roundTo(viewpoint.distance, HEIGHT_DECIMALS);
  }
  if (typeof viewpoint.heading === 'number') {
    normalized.heading = roundTo(viewpoint.heading, ANGLE_DECIMALS);
  }
  if (typeof viewpoint.pitch === 'number') {
    normalized.pitch = roundTo(viewpoint.pitch, ANGLE_DECIMALS);
  }
  if (typeof viewpoint.roll === 'number') {
    normalized.roll = roundTo(viewpoint.roll, ANGLE_DECIMALS);
  }
  return normalized;
}

/**
 * Returns a copy of the state with the active viewpoint normalized, so an
 * unchanged view yields a stable serialization for change detection.
 */
export function normalizeState(state: AppState): AppState {
  if (!state.activeViewpoint) {
    return state;
  }
  return {
    ...state,
    activeViewpoint: normalizeViewpoint(state.activeViewpoint),
  };
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
 * Removes the `state` URL parameter after the app has read it (the app parses it
 * once, at construction). This prevents a page reload from re-applying the shared
 * state and overwriting the changes the user made during the session, which are
 * kept in localStorage. Must be called after `restoreStateFromLocalStorage`,
 * which relies on the parameter to detect that the URL takes precedence.
 */
export function clearStateUrlParam(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.has('state')) {
    url.searchParams.delete('state');
    window.history.replaceState(window.history.state, '', url);
  }
}

/**
 * Returns `current`, with entries from `previous` appended for names that are
 * not in `current` and no longer exist in the app. Used to keep the persisted
 * state of layers/clipping polygons that are temporarily absent (e.g. a layer
 * only available while logged in), so logging out does not drop their state.
 */
function preserveAbsentEntries<T extends { name: string }>(
  current: T[],
  previous: T[],
  exists: (name: string) => boolean,
): T[] {
  const currentNames = new Set(current.map((entry) => entry.name));
  const kept = previous.filter(
    (entry) => !currentNames.has(entry.name) && !exists(entry.name),
  );
  return kept.length ? [...current, ...kept] : current;
}

function getModuleId(module: VcsModule): string {
  return module._id;
}

async function readViewpointKey(app: VcsUiApp): Promise<string> {
  const map = app.maps.activeMap;
  if (!map) {
    return '';
  }
  try {
    const viewpoint = await map.getViewpoint();
    if (viewpoint?.isValid?.()) {
      return JSON.stringify(normalizeViewpoint(viewpoint.toJSON()));
    }
  } catch {
    // ignore: no valid viewpoint yet
  }
  return '';
}

/**
 * Continuously persists the app state to the localStorage, throttled to one
 * write per second. Returns a dispose function removing all listeners.
 *
 * The map fires postRender every frame, but a full `getState()` is expensive
 * (it scans every layer and module) and is only meaningful when something
 * changed. So a render only triggers a cheap viewpoint read; the full
 * `getState()` runs only when the view actually moved or a discrete event
 * (layer/clipping polygon/map change) requested it.
 *
 * State is also preserved across a module reload (e.g. the themesync plugin
 * removing and re-adding its module on login/logout): when a module is removed,
 * the last known layer/clipping-polygon states are re-seeded into the app's
 * cached state, so the re-added module re-applies them. Entries for layers that
 * are temporarily absent (only available while logged in) are kept in the
 * persisted state instead of being dropped.
 */
export function startStateSync(app: VcsUiApp): () => void {
  let lastWritten: string | undefined;
  let lastViewpointKey: string | undefined;
  let forced = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // last persisted state, used both as the merge baseline and to re-seed the
  // cached state on a module reload. Initialised from the stored state so a
  // reload that happens before the first persist is still covered.
  let lastState: AppState | undefined = readStoredState();

  async function tick(): Promise<void> {
    timer = undefined;
    const viewpointKey = await readViewpointKey(app);
    const viewpointChanged = viewpointKey !== lastViewpointKey;
    lastViewpointKey = viewpointKey;
    if (!forced && !viewpointChanged) {
      return;
    }
    forced = false;
    try {
      const state = await app.getState(true);
      if (lastState) {
        state.layers = preserveAbsentEntries(
          state.layers,
          lastState.layers,
          (layerName) => !!app.layers.getByKey(layerName),
        );
        state.clippingPolygons = preserveAbsentEntries(
          state.clippingPolygons,
          lastState.clippingPolygons,
          (polygonName) => !!app.clippingPolygons.getByKey(polygonName),
        );
      }
      const normalized = normalizeState(state);
      const json = JSON.stringify(normalized);
      if (json !== lastWritten) {
        setToLocalStorage(name, STATE_KEY, json);
        lastWritten = json;
      }
      lastState = normalized;
    } catch {
      // getState throws as long as no map is active yet
    }
  }

  // Re-seed the cached state before a removed module is re-added, so the app
  // re-applies the layer and clipping-polygon states through its own startup
  // mechanism. Layers/polygons that no longer exist are skipped by the app.
  // Viewpoint and active map are intentionally omitted: a module reload does
  // not move the camera, and re-applying them could cause a jump.
  function seedReloadState(removedModule: VcsModule): void {
    if (!lastState) {
      return;
    }
    const moduleId = getModuleId(removedModule);
    if (moduleId === app.dynamicModuleId) {
      return;
    }
    setCachedAppState(app, {
      moduleIds: [moduleId],
      layers: lastState.layers.map((layer) => ({ ...layer })),
      clippingPolygons: lastState.clippingPolygons.map((polygon) => ({
        ...polygon,
      })),
      plugins: [],
    });
  }

  function schedule(): void {
    if (!timer) {
      timer = setTimeout(() => {
        tick().catch(() => {});
      }, PERSIST_THROTTLE_MS);
    }
  }

  function scheduleForced(): void {
    forced = true;
    schedule();
  }

  let postRenderListener: (() => void) | undefined;
  function bindPostRender(map: VcsMap | null): void {
    postRenderListener?.();
    postRenderListener = map?.postRender.addEventListener(schedule);
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
    app.layers.stateChanged.addEventListener(scheduleForced),
    clippingPolygonsStateChanged?.addEventListener(scheduleForced),
    app.maps.mapActivated.addEventListener((map) => {
      bindPostRender(map);
      scheduleForced();
    }),
    app.moduleRemoved.addEventListener(seedReloadState),
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
