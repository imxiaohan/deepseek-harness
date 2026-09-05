import { defineConfig } from 'tsdown'

/**
 * Electron-native directory backend: a thin host plugin that routes the
 * chooser through the desktop carrier to Electron main, so it owns no
 * Electron import of its own (the host child runs under plain Node).
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])