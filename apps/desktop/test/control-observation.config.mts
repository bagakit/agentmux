import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Explicit owning tests use the current workspace packages built by the integration owner.
const ipcSource = fileURLToPath(new URL('../src/main/ipc.ts', import.meta.url))
export default defineConfig({
  // The mutation helper observes the original TS in its pre-transform. Only this Main
  // bootstrap is then exposed as source, so tests execute its real extracted callbacks.
  plugins: [{ name: 'production-ipc-callback-source', enforce: 'post', transform(_source, id) {
    if (id === ipcSource) return { code: `export const sourceText = ${JSON.stringify(readFileSync(ipcSource, 'utf8'))};`, map: null }
  } }],
  test: {
    include: ['apps/desktop/test/{control-ipc-bridge,control-api,control-renderer-lifecycle,file-format-observation,file-format-controller}.test.ts'],
    passWithNoTests: false
  }
})
