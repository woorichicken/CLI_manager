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
  main: {
    // The phone server bundles `ws`. Vite turns its optional native helpers (bufferutil,
    // utf-8-validate) into empty objects, so ws's try/require "succeeds" and calls a missing
    // `unmask` on every client frame of 32 bytes or more — main froze for minutes (T76).
    // These switches are ws's own way to skip them; it falls back to its JS code (and Node's isUtf8).
    define: {
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('1'),
      'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('1')
    }
  },
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
