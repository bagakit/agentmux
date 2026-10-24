import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import base from './hook-postcommit-observation.vitest.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, [string, string, string]> = {
  'drop-creation-receipt': ['packages/core/src/ctxmux-run-adapter.ts',
    '{ operationId: creation.operation_key, disposition: creation.disposition }', 'undefined'],
  'trust-foreign-creation': ['packages/core/src/client.ts',
    'error.creationFailure?.operationId === lifecycleOperationId &&', 'error.creationFailure !== undefined &&'],
  'drop-storage-diagnostic': ['packages/core/src/public-rpc-frame.ts',
    '...(source?.storageFailure === undefined ? {} : { storageFailure: parseAgentMuxStorageFailure(source.storageFailure) }),', '']
}
const mutation = process.env.AGENTMUX_PERSISTENCE_MUTATION
const loadedFile = process.env.AGENTMUX_PERSISTENCE_LOADED
if (mutation && !mutations[mutation]) throw new Error('Unknown persistence recovery mutation')
export default { ...base, root, resolve: { alias: [
  { find: '@agentmux/identity/runtime-source', replacement: resolve(root, 'packages/identity/dist/runtime-source.js') },
  ...(process.env.CTXMUX_TEST_SDK_SOURCE ? [{ find: /^@ctxmux\/sdk$/, replacement: resolve(process.env.CTXMUX_TEST_SDK_SOURCE) }] : []),
  ...base.resolve.alias
] }, plugins: [{ name: 'persistence-recovery-loaded-source', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.includes('?')) return
    const path = relative(root, id)
    if (!path.startsWith('packages/core/src/') && !path.startsWith('packages/core/test/')) return
    let code = source
    if (mutation && path === mutations[mutation]![0]) {
      const [, before, after] = mutations[mutation]!
      if (source.split(before).length !== 2) throw new Error('Mutation anchor must name the actual owner exactly once')
      code = source.replace(before, after)
    }
    if (loadedFile) appendFileSync(loadedFile,
      JSON.stringify({ path, originalSHA256: createHash('sha256').update(source).digest('hex'),
        loadedSHA256: createHash('sha256').update(code).digest('hex'), ...(code !== source ? { mutation } : {}) }) + '\n')
    if (code !== source) return { code, map: null }
  }
}], test: { ...base.test, include: ['packages/core/test/persistence-failure-contract.test.ts',
  'packages/core/test/run-storage-observation.test.ts', 'packages/core/test/durable-local-creation.test.ts',
  'packages/core/test/ctxmux-native-service.test.ts'],
  passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000 } }
