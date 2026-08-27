import { defineConfig } from 'tsdown'

/**
 * The desktop shell ships one entry: the Electron `main` referenced by
 * package.json. The root tsdown builds only `lib/types/index.js`, so this
 * override points at `lib/types/main.js` instead. Declarations come from
 * `tsc -b` (dts: false), matching every app package.
 */
export default defineConfig({
  entry: ['lib/types/main.js', 'lib/types/host.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  // `electron` resolves to Electron's built-in module inside the main
  // process; bundling the npm package would inline its binary-path resolver.
  external: ['electron'],
})
