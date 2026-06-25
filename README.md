# lux-3dviewer-plugin-statesync

> Part of the [VC Map Project](https://github.com/virtualcitySYSTEMS/map-ui)

This plugin persists the current VC Map application state (active map, viewpoint, layer activation and styles, oblique collection, clipping polygons, plugin states) to the browser's `localStorage` and restores it on the next visit. It writes the same state used for sharable `?state=` URLs, throttled and only when something actually changes. A `?state=` URL keeps priority over the stored state, and state is preserved across a module reload (e.g. on login/logout), keeping layers that are temporarily unavailable.

## Development

To further develop the plugin run: `npm start`

## Config parameters

This plugin has no config parameters.

## Deploy plugin within map-ui

- Add plugin dependency in desired version to `plugins/package.json`:

```
"dependencies": {
  ...
  "@geoportallux/lux-3dviewer-plugin-statesync": "...",
  ...
```

- Add plugin to map-ui module configuration. List it **first** in the `plugins` array, ahead of any plugin that restores its own state from the `state` argument of `initialize(app, state)`, since this plugin must seed the cached state before those plugins are initialized:

```
    {
      "name": "@geoportallux/lux-3dviewer-plugin-statesync",
      "entry": "plugins/@geoportallux/lux-3dviewer-plugin-statesync/index.js",
    },
```

> Note: restore only takes effect for modules whose `_id` is stable across sessions. In the Geoportail viewer this is provided by the themesync plugin (stable `_id: 'catalogConfig'`), which triggers the restore once its module loads.

## Build the npm package

Use the following commands to increase the version and push a new tag, which builds a new version as npm package:

```shell
npm version 1.0.0 --no-git-tag-version
git add .
git commit -m "1.0.0"
git tag v1.0.0
git push origin main v1.0.0 # replace "origin" with your remote repo name
```
