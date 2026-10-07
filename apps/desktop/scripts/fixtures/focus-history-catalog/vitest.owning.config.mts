import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from '../focus-card-identity/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/focus-history-catalog/vitest-cache'),
  plugins: [...shared.plugins ?? [], { name: 'original-focus-source-catalogue', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'apps/desktop/src/renderer/src/lib/focus-history-sources.ts') return
    const needle = 'loaded.current = true; setSources(values); setError(null)'
    let served = code
    if (process.env.AGENTMUX_CATALOG_MUTATION) {
      if (code.split(needle).length !== 2) throw new Error('The original catalogue consumer must be loaded exactly once.')
      served = code.replace(needle, `if (values.length > 512) throw new Error('Population admission mutation'); ${needle}`)
    }
    if (process.env.AGENTMUX_CATALOG_LOADED) writeFileSync(process.env.AGENTMUX_CATALOG_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
      servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }))
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...shared.test, include: ['apps/desktop/test/focus-history-catalog.test.tsx'], passWithNoTests: false }
})
