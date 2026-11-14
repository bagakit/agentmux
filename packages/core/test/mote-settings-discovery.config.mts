import { defineConfig } from 'vitest/config'
import source from './a2a-resumed-inbox.config.mts'
import { relative, resolve } from 'node:path'
import { transformMoteDiscoverySource } from './mote-settings-discovery-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  ...source,
  cacheDir: resolve(root, '.local/mote-settings-robustness/owner-cache'),
  plugins: [{
    name: 'mote-settings-discovery-evaluated-source', enforce: 'pre',
    transform(code, id) {
      const loaded = transformMoteDiscoverySource(code, relative(root, id.split('?')[0]!))
      return loaded === code ? null : { code: loaded, map: null }
    }
  }, ...(source.plugins ?? [])],
  test: { ...source.test, include: ['packages/core/test/mote-settings-discovery.test.ts'],
    fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 15000, passWithNoTests: false }
})
