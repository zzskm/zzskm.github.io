Three.js r180 / npm 0.180.0 (MIT)

Vendored from https://cdn.jsdelivr.net/npm/three@0.180.0/ :

- build/three.module.js
- build/three.core.js
- examples/jsm/controls/OrbitControls.js
- examples/jsm/loaders/STLLoader.js
- LICENSE

Only modification: the two addons import `./three.module.js` instead of the bare
`three` package name. Local relative modules work under GitHub Pages subpaths
without a bundler, import map, or a runtime CDN dependency.
