import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VcsEvent } from '@vcmap/core';
import type { AppState } from '@vcmap/ui';
import { VcsUiApp, createEmptyState } from '@vcmap/ui';
import packageJSON from '../package.json';
import {
  STATE_KEY,
  getCachedAppState,
  setCachedAppState,
  normalizeState,
  readStoredState,
  restoreStateFromLocalStorage,
  clearStateUrlParam,
  startStateSync,
} from '../src/stateSync.js';

const storageKey = `${packageJSON.name}_${STATE_KEY}`;

function getValidState(): AppState {
  return {
    moduleIds: ['LuxConfig', 'catalogConfig'],
    activeMap: 'CesiumMap',
    activeViewpoint: { heading: 0, pitch: -90, roll: 0 },
    layers: [
      { name: 'layer1', active: true },
      { name: 'layer2', active: false, styleName: 'someStyle' },
    ],
    plugins: [],
    clippingPolygons: [{ name: 'polygon1', active: true }],
  };
}

describe('stateSync', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('_cachedAppState canary', () => {
    it('is exposed by VcsUiApp shaped like an empty state (private API this plugin relies on)', () => {
      const app = new VcsUiApp();
      expect(getCachedAppState(app)).toEqual(createEmptyState());
      app.destroy();
    });
  });

  describe('normalizeState', () => {
    it('drops the volatile name and rounds the active viewpoint', () => {
      const state: AppState = {
        ...getValidState(),
        activeViewpoint: {
          type: 'Viewpoint',
          name: 'some-random-uuid',
          cameraPosition: [6.123456789, 49.987654321, 1234.56789],
          groundPosition: [6.111111111, 49.222222222, 0.123456],
          distance: 1234.56789,
          heading: 12.3456789,
          pitch: -45.6789012,
          roll: 0.0009999,
        },
      };
      expect(normalizeState(state).activeViewpoint).toEqual({
        type: 'Viewpoint',
        cameraPosition: [6.1234568, 49.9876543, 1234.57],
        groundPosition: [6.1111111, 49.2222222, 0.12],
        distance: 1234.57,
        heading: 12.346,
        pitch: -45.679,
        roll: 0.001,
      });
    });

    it('returns the state unchanged when there is no active viewpoint', () => {
      const state = getValidState();
      delete state.activeViewpoint;
      expect(normalizeState(state)).toBe(state);
    });
  });

  describe('readStoredState', () => {
    it('returns the stored state', () => {
      const state = getValidState();
      localStorage.setItem(storageKey, JSON.stringify(state));
      expect(readStoredState()).toEqual(state);
    });

    it('returns undefined if nothing is stored', () => {
      expect(readStoredState()).toBeUndefined();
    });

    it('removes invalid JSON and returns undefined', () => {
      localStorage.setItem(storageKey, 'not json');
      expect(readStoredState()).toBeUndefined();
      expect(localStorage.getItem(storageKey)).toBeNull();
    });

    it('removes JSON of the wrong shape and returns undefined', () => {
      localStorage.setItem(storageKey, JSON.stringify({ layers: 'nope' }));
      expect(readStoredState()).toBeUndefined();
      expect(localStorage.getItem(storageKey)).toBeNull();
    });
  });

  describe('restoreStateFromLocalStorage', () => {
    let app: VcsUiApp;

    beforeEach(() => {
      app = new VcsUiApp();
    });

    afterEach(() => {
      app.destroy();
    });

    it('injects the stored state into the cached app state, keeping moduleIds verbatim', () => {
      const state = getValidState();
      localStorage.setItem(storageKey, JSON.stringify(state));
      restoreStateFromLocalStorage(app);
      expect(getCachedAppState(app)).toEqual(state);
      expect(getCachedAppState(app)?.moduleIds).toEqual([
        'LuxConfig',
        'catalogConfig',
      ]);
    });

    it('does nothing without a stored state', () => {
      restoreStateFromLocalStorage(app);
      expect(getCachedAppState(app)).toEqual(createEmptyState());
    });

    it('does nothing when a state URL parameter is present', () => {
      localStorage.setItem(storageKey, JSON.stringify(getValidState()));
      window.history.replaceState(null, '', '?state=%5B%5D');
      try {
        restoreStateFromLocalStorage(app);
        expect(getCachedAppState(app)).toEqual(createEmptyState());
      } finally {
        window.history.replaceState(null, '', window.location.pathname);
      }
    });

    it('never clobbers an already cached state', () => {
      localStorage.setItem(storageKey, JSON.stringify(getValidState()));
      const cachedFromUrl = { ...createEmptyState(), moduleIds: ['module1'] };
      setCachedAppState(app, cachedFromUrl);
      restoreStateFromLocalStorage(app);
      expect(getCachedAppState(app)).toEqual(cachedFromUrl);
    });

    it('warns and skips restore if the app does not expose _cachedAppState', () => {
      localStorage.setItem(storageKey, JSON.stringify(getValidState()));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const appWithoutCache: unknown = {};
      try {
        expect(() => {
          restoreStateFromLocalStorage(appWithoutCache as VcsUiApp);
        }).not.toThrow();
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('clearStateUrlParam', () => {
    afterEach(() => {
      window.history.replaceState(null, '', window.location.pathname);
    });

    it('removes the state parameter, keeping other params', () => {
      window.history.replaceState(null, '', '?foo=bar&state=%5B%5D');
      clearStateUrlParam();
      const url = new URL(window.location.href);
      expect(url.searchParams.has('state')).toBe(false);
      expect(url.searchParams.get('foo')).toBe('bar');
    });

    it('does nothing when there is no state parameter', () => {
      window.history.replaceState(null, '', '?foo=bar');
      expect(() => {
        clearStateUrlParam();
      }).not.toThrow();
      const url = new URL(window.location.href);
      expect(url.searchParams.get('foo')).toBe('bar');
      expect(url.searchParams.has('state')).toBe(false);
    });
  });

  describe('startStateSync', () => {
    type FakeMap = {
      postRender: VcsEvent<unknown>;
      getViewpoint: ReturnType<typeof vi.fn>;
    };
    type StubApp = {
      layers: {
        stateChanged: VcsEvent<unknown>;
        getByKey: (k: string) => unknown;
      };
      clippingPolygons: {
        stateChanged: VcsEvent<unknown>;
        getByKey: (k: string) => unknown;
      };
      maps: {
        mapActivated: VcsEvent<unknown>;
        activeMap: FakeMap | null;
      };
      moduleRemoved: VcsEvent<unknown>;
      dynamicModuleId: string;
      getState: ReturnType<typeof vi.fn>;
    };

    // a Viewpoint-like result as returned by map.getViewpoint()
    function viewpointResult(vp: object): {
      isValid: () => boolean;
      toJSON: () => object;
    } {
      return { isValid: () => true, toJSON: () => vp };
    }

    function makeMap(vp?: object): FakeMap {
      return {
        postRender: new VcsEvent(),
        getViewpoint: vi
          .fn()
          .mockResolvedValue(vp ? viewpointResult(vp) : null),
      };
    }

    let stubApp: StubApp;
    let app: VcsUiApp;
    let stopStateSync: (() => void) | undefined;

    beforeEach(() => {
      vi.useFakeTimers();
      stubApp = {
        // by default every name "exists" in the app, so nothing is preserved
        layers: { stateChanged: new VcsEvent(), getByKey: (): unknown => ({}) },
        clippingPolygons: {
          stateChanged: new VcsEvent(),
          getByKey: (): unknown => ({}),
        },
        maps: {
          mapActivated: new VcsEvent(),
          activeMap: makeMap(),
        },
        moduleRemoved: new VcsEvent(),
        dynamicModuleId: '_defaultDynamicModule',
        getState: vi.fn().mockResolvedValue(getValidState()),
      };
      app = stubApp as unknown as VcsUiApp;
    });

    afterEach(() => {
      stopStateSync?.();
      stopStateSync = undefined;
      vi.useRealTimers();
    });

    async function flushThrottle(): Promise<void> {
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    it('persists the app state once per throttle window on discrete changes', async () => {
      stopStateSync = startStateSync(app);
      stubApp.layers.stateChanged.raiseEvent(undefined);
      stubApp.layers.stateChanged.raiseEvent(undefined);
      stubApp.clippingPolygons.stateChanged.raiseEvent(undefined);
      expect(localStorage.getItem(storageKey)).toBeNull();
      await flushThrottle();
      expect(stubApp.getState).toHaveBeenCalledExactlyOnceWith(true);
      expect(localStorage.getItem(storageKey)).toEqual(
        JSON.stringify(getValidState()),
      );
    });

    it('does not write again if the state is unchanged', async () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      try {
        stopStateSync = startStateSync(app);
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();
        expect(setItem).toHaveBeenCalledOnce();
      } finally {
        setItem.mockRestore();
      }
    });

    it('does not call getState while the view is idle (no warning spam)', async () => {
      stubApp.maps.activeMap = makeMap({ cameraPosition: [6.1, 49.7, 300] });
      stopStateSync = startStateSync(app);
      // first render establishes the baseline and writes once
      stubApp.maps.activeMap.postRender.raiseEvent(undefined);
      await flushThrottle();
      expect(stubApp.getState).toHaveBeenCalledOnce();
      stubApp.getState.mockClear();
      // subsequent idle renders must not call the expensive getState
      for (let i = 0; i < 3; i += 1) {
        stubApp.maps.activeMap.postRender.raiseEvent(undefined);
        // eslint-disable-next-line no-await-in-loop
        await flushThrottle();
      }
      expect(stubApp.getState).not.toHaveBeenCalled();
    });

    it('does not write on sub-precision viewpoint jitter from re-renders', async () => {
      const map = makeMap({ cameraPosition: [6.1234567, 49.7654321, 300] });
      stubApp.maps.activeMap = map;
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      try {
        stopStateSync = startStateSync(app);
        map.postRender.raiseEvent(undefined);
        await flushThrottle();
        // a re-render reads the camera again with last-digit float noise
        map.getViewpoint.mockResolvedValue(
          viewpointResult({
            cameraPosition: [6.12345671, 49.76543209, 300.0000001],
          }),
        );
        map.postRender.raiseEvent(undefined);
        await flushThrottle();
        expect(setItem).toHaveBeenCalledOnce();
      } finally {
        setItem.mockRestore();
      }
    });

    it('writes the changed state on real viewpoint movement (postRender)', async () => {
      const map = makeMap({ cameraPosition: [6.1, 49.7, 300] });
      stubApp.maps.activeMap = map;
      stopStateSync = startStateSync(app);
      map.postRender.raiseEvent(undefined);
      await flushThrottle();
      const changedState = { ...getValidState(), activeMap: 'ObliqueMap' };
      stubApp.getState.mockResolvedValue(changedState);
      map.getViewpoint.mockResolvedValue(
        viewpointResult({ cameraPosition: [7.2, 50.1, 800] }),
      );
      map.postRender.raiseEvent(undefined);
      await flushThrottle();
      expect(localStorage.getItem(storageKey)).toEqual(
        JSON.stringify(changedState),
      );
    });

    it('rebinds the postRender listener on map activation', async () => {
      stubApp.maps.activeMap = null;
      stopStateSync = startStateSync(app);
      const newMap = makeMap({ cameraPosition: [6.1, 49.7, 300] });
      stubApp.maps.activeMap = newMap;
      stubApp.maps.mapActivated.raiseEvent(newMap);
      await flushThrottle();
      stubApp.getState.mockClear();
      // a real camera move on the newly activated map must trigger a persist
      newMap.getViewpoint.mockResolvedValue(
        viewpointResult({ cameraPosition: [7.2, 50.1, 800] }),
      );
      newMap.postRender.raiseEvent(undefined);
      await flushThrottle();
      expect(stubApp.getState).toHaveBeenCalledOnce();
    });

    it('stops persisting once disposed', async () => {
      const map = stubApp.maps.activeMap!;
      stopStateSync = startStateSync(app);
      stopStateSync();
      stopStateSync = undefined;
      stubApp.layers.stateChanged.raiseEvent(undefined);
      stubApp.clippingPolygons.stateChanged.raiseEvent(undefined);
      map.postRender.raiseEvent(undefined);
      await flushThrottle();
      expect(stubApp.getState).not.toHaveBeenCalled();
      expect(localStorage.getItem(storageKey)).toBeNull();
    });

    it('ignores getState failures (no active map yet)', async () => {
      stubApp.getState.mockRejectedValue(new Error('no active map'));
      stopStateSync = startStateSync(app);
      stubApp.layers.stateChanged.raiseEvent(undefined);
      await flushThrottle();
      expect(localStorage.getItem(storageKey)).toBeNull();
    });

    describe('module reload preservation (login/logout)', () => {
      it('re-seeds the cached state on module removal so the re-add restores it', async () => {
        stubApp.getState.mockResolvedValue(getValidState());
        stopStateSync = startStateSync(app);
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();
        expect(getCachedAppState(app)).toBeUndefined();

        stubApp.moduleRemoved.raiseEvent({ _id: 'catalogConfig' });

        // layers + clipping polygons re-seeded; viewpoint/map omitted (no jump)
        expect(getCachedAppState(app)).toEqual({
          moduleIds: ['catalogConfig'],
          layers: getValidState().layers,
          clippingPolygons: getValidState().clippingPolygons,
          plugins: [],
        });
      });

      it('does not re-seed on dynamic module removal', async () => {
        stubApp.getState.mockResolvedValue(getValidState());
        stopStateSync = startStateSync(app);
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();
        stubApp.moduleRemoved.raiseEvent({ _id: stubApp.dynamicModuleId });
        expect(getCachedAppState(app)).toBeUndefined();
      });

      it('keeps the state of layers that became absent from the app', async () => {
        stubApp.getState.mockResolvedValue({
          ...getValidState(),
          layers: [
            { name: 'public', active: true },
            { name: 'restricted', active: true },
          ],
          clippingPolygons: [],
        });
        stopStateSync = startStateSync(app);
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();

        // logout: the restricted layer is gone, getState only returns public
        stubApp.getState.mockResolvedValue({
          ...getValidState(),
          layers: [{ name: 'public', active: true }],
          clippingPolygons: [],
        });
        stubApp.layers.getByKey = (n: string): unknown =>
          n === 'restricted' ? undefined : {};
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();

        const stored = JSON.parse(localStorage.getItem(storageKey)!);
        expect(stored.layers).toEqual([
          { name: 'public', active: true },
          { name: 'restricted', active: true },
        ]);
      });

      it('drops the state of a layer that still exists but is no longer active', async () => {
        stubApp.getState.mockResolvedValue({
          ...getValidState(),
          layers: [{ name: 'X', active: true }],
          clippingPolygons: [],
        });
        stopStateSync = startStateSync(app);
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();

        // X is deactivated: getState excludes it, but X still exists in the app
        stubApp.getState.mockResolvedValue({
          ...getValidState(),
          layers: [],
          clippingPolygons: [],
        });
        stubApp.layers.stateChanged.raiseEvent(undefined);
        await flushThrottle();

        const stored = JSON.parse(localStorage.getItem(storageKey)!);
        expect(stored.layers).toEqual([]);
      });
    });
  });
});
