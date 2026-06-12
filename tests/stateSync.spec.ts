import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VcsEvent } from '@vcmap/core';
import type { AppState } from '@vcmap/ui';
import { VcsUiApp, createEmptyState } from '@vcmap/ui';
import packageJSON from '../package.json';
import {
  STATE_KEY,
  getCachedAppState,
  setCachedAppState,
  readStoredState,
  restoreStateFromLocalStorage,
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

  describe('startStateSync', () => {
    type StubApp = {
      layers: { stateChanged: VcsEvent<unknown> };
      clippingPolygons: { stateChanged: VcsEvent<unknown> };
      maps: {
        mapActivated: VcsEvent<unknown>;
        activeMap: { postRender: VcsEvent<unknown> } | null;
      };
      getState: ReturnType<typeof vi.fn>;
    };

    let stubApp: StubApp;
    let app: VcsUiApp;
    let stopStateSync: (() => void) | undefined;

    beforeEach(() => {
      vi.useFakeTimers();
      stubApp = {
        layers: { stateChanged: new VcsEvent() },
        clippingPolygons: { stateChanged: new VcsEvent() },
        maps: {
          mapActivated: new VcsEvent(),
          activeMap: { postRender: new VcsEvent() },
        },
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
    }

    it('persists the app state once per throttle window', async () => {
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

    it('writes the changed state on viewpoint changes (postRender)', async () => {
      stopStateSync = startStateSync(app);
      stubApp.maps.activeMap?.postRender.raiseEvent(undefined);
      await flushThrottle();
      const changedState = { ...getValidState(), activeViewpoint: undefined };
      stubApp.getState.mockResolvedValue(changedState);
      stubApp.maps.activeMap?.postRender.raiseEvent(undefined);
      await flushThrottle();
      expect(localStorage.getItem(storageKey)).toEqual(
        JSON.stringify(changedState),
      );
    });

    it('rebinds the postRender listener on map activation', async () => {
      stubApp.maps.activeMap = null;
      stopStateSync = startStateSync(app);
      const newMap = { postRender: new VcsEvent<unknown>() };
      stubApp.maps.mapActivated.raiseEvent(newMap);
      await flushThrottle();
      stubApp.getState.mockClear();
      newMap.postRender.raiseEvent(undefined);
      await flushThrottle();
      expect(stubApp.getState).toHaveBeenCalledOnce();
    });

    it('stops persisting once disposed', async () => {
      stopStateSync = startStateSync(app);
      stopStateSync();
      stopStateSync = undefined;
      stubApp.layers.stateChanged.raiseEvent(undefined);
      stubApp.clippingPolygons.stateChanged.raiseEvent(undefined);
      stubApp.maps.activeMap?.postRender.raiseEvent(undefined);
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
  });
});
