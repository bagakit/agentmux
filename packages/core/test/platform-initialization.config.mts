import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import source from './a2a-resumed-inbox.config.mts'
import { instrumentInitialization } from './fixtures/platform-initialization-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...source, plugins: [...(source.plugins ?? []), { name: 'original-platform-initialization', enforce: 'pre',
  transform(code, id) {
    const loaded = instrumentInitialization(code, relative(root, id.split('?')[0]!), 'vitest')
    if (loaded !== code) return { code: loaded, map: null }
  }
}], test: { ...source.test, include: ['packages/core/test/platform-initialization-input.test.ts', 'packages/core/test/native-history-input-continuity.test.ts',
    'packages/core/test/platform-initialization-diagnostic-lifetime.test.ts', 'apps/host/test/mote-existing-platform-input.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 30000 } })
