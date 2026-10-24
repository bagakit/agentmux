import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.CONNECTION_API_CORE_MUTANT
if (mutation && mutation !== 'foreign-identities') throw Error('Unknown Core native API mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.cache/connection-api-core'), plugins: [{ name: 'connection-api-core-qualified', enforce: 'pre', transform(source, id) {
  const path = relative(root, id.split('?')[0]!)
  if (!/^packages\/core\/(?:src|test)\/.+\.(?:ts|mts)$/u.test(path)) return
  let loaded = source
  if (mutation && path === 'packages/core/src/public-rpc-service.ts') {
    const before = "method === 'connection.api.identities' && caller && (input as { agentSessionId: string }).agentSessionId !== caller.session.agentSessionId"
    if (source.split(before).length !== 2) throw Error('Exact original-Session guard must load once')
    loaded = source.replace(before, 'false')
  }
  if (process.env.CONNECTION_API_CORE_LOADED) {
    const sha = (v: string) => createHash('sha256').update(v).digest('hex')
    const row = { path, originalSHA256: sha(source), loadedSHA256: sha(loaded), ...(source !== loaded ? { mutation } : {}) }
    loaded = `import {appendFileSync as __apiLoaded} from 'node:fs'; __apiLoaded(${JSON.stringify(process.env.CONNECTION_API_CORE_LOADED)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + loaded
  }
  return { code: loaded, map: null }
} }], test: { include: ['packages/core/test/connection-api-codec.test.ts', 'packages/core/test/connection-api-public-consumer.test.ts'], environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000 } })
