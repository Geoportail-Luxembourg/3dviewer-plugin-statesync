import type { VcsPlugin, VcsUiApp, PluginConfigEditor } from '@vcmap/ui';
import { name, version, mapVersion } from '../package.json';
import {
  clearStateUrlParam,
  restoreStateFromLocalStorage,
  startStateSync,
} from './stateSync.js';

type PluginConfig = Record<never, never>;
type PluginState = Record<never, never>;

type StateSyncPlugin = VcsPlugin<PluginConfig, PluginState>;

export default function plugin(): StateSyncPlugin {
  let stopStateSync: (() => void) | undefined;

  return {
    get name(): string {
      return name;
    },
    get version(): string {
      return version;
    },
    get mapVersion(): string {
      return mapVersion;
    },
    initialize(vcsUiApp: VcsUiApp): Promise<void> {
      // must run synchronously, before any module the state applies to is loaded
      restoreStateFromLocalStorage(vcsUiApp);
      // the app has already read the state URL parameter into its cached state;
      // remove it so a reload restores from localStorage (with any in-session
      // changes) instead of re-applying the shared URL state
      clearStateUrlParam();
      return Promise.resolve();
    },
    onVcsAppMounted(vcsUiApp: VcsUiApp): void {
      stopStateSync = startStateSync(vcsUiApp);
    },
    /**
     * should return all default values of the configuration
     */
    getDefaultOptions(): PluginConfig {
      return {};
    },
    /**
     * should return the plugin's serialization excluding all default values
     */
    toJSON(): PluginConfig {
      return {};
    },
    /**
     * should return the plugins state
     * @returns {PluginState}
     */
    getState(): PluginState {
      return {};
    },
    /**
     * components for configuring the plugin and/ or custom items defined by the plugin
     */
    getConfigEditors(): PluginConfigEditor<object>[] {
      return [];
    },
    destroy(): void {
      stopStateSync?.();
      stopStateSync = undefined;
    },
  };
}
