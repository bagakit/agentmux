import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import preparation from './vitest.hosted-input-preparation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_AGENT_ADMISSION_MUTATION
if (mutation && !['main-preflight', 'stale-owner', 'stale-warning'].includes(mutation)) throw Error('Unknown Agent admission mutation')
export default defineConfig({
  resolve: preparation.resolve, cacheDir: '.cache/hosted-agent-input-admission',
  plugins: [{ name: 'actual-agent-admission-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id)
    if (!['packages/core/src/hosted-client.ts', 'apps/desktop/src/main/runtime-controller.ts'].includes(path)) return
    const replacement = mutation === 'main-preflight' && path.endsWith('/runtime-controller.ts')
      ? ["if (scope === 'agent-input' && 'runtimeOwnerIdentity' in client) return client", '']
      : mutation === 'stale-owner' && path.endsWith('/hosted-client.ts')
        ? ["method === 'connectRuntime' || method === 'writeAgent' || method === 'pasteAgent'", "method === 'connectRuntime'"]
        : mutation === 'stale-warning' && path.endsWith('/runtime-controller.ts')
          ? ["!failure && runtimeOwner(client)?.availability === 'connected' &&", '!failure &&'] : undefined
    let code = source
    if (replacement) {
      if (source.split(replacement[0]!).length !== 2) throw Error('Expected one loaded production admission mutation')
      code = source.replace(replacement[0]!, replacement[1]!)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_AGENT_ADMISSION_LOADED) appendFileSync(process.env.AGENTMUX_AGENT_ADMISSION_LOADED,
      JSON.stringify({ path, original: hash(source), loaded: hash(code), mutation: replacement ? mutation : null }) + '\n')
    return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/hosted-input-preparation.test.ts', 'apps/desktop/test/desktop-host-channel.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false,
    testTimeout: 15000, hookTimeout: 15000, passWithNoTests: false }
})
