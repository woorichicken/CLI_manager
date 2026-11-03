import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

/**
 * electron-vite reads only `electron.vite.config.*`. Main and preload keep its defaults
 * (entries under src/, `dependencies` left external). The renderer gets a second entry:
 * the phone page (Settings › Phone), which the phone server serves with only the chunks
 * Vite's manifest says phone.html loads — never the desktop app's own.
 *
 * (`electron-vite.config.ts` beside this file has never been loaded — wrong name.)
 */
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      manifest: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          phone: resolve(__dirname, 'src/renderer/phone.html')
        }
      }
    }
  }
})
