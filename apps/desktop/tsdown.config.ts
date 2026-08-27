import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships the Electron main, host-child, and preload entries.
 * The root tsdown builds only `lib/types/index.js`, so this override names the
 * three application entries. Declarations come from `tsc -b` (dts: false),
 * matching every app package.
 */
export default defineConfig({
  entry: ['lib/types/main.js', 'lib/types/host.js', 'lib/types/preload.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // `electron` and `electron/main` resolve to Electron's built-in modules
  // inside the main process; bundling the npm package would inline its
  // binary-path resolver.
  deps: { neverBundle: ['electron', 'electron/main'] },
})
