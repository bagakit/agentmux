import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { instrumentCommitContentionSource } from './mutations.mjs'

const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/session-commit-contention-vite'),
  plugins: [{ name: 'session-commit-contention-owning-source', enforce: 'pre',
    transform(source, id) {
      const path = relative(root, id.split('?')[0]!)
      const loaded = instrumentCommitContentionSource(source, path)
      return loaded === source ? null : { code: loaded, map: null }
    } }],
  test: { include: ['packages/core/test/session-commit-contention.test.ts'], setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 30000, hookTimeout: 30000 }
})
