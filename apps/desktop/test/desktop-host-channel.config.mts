import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import preparation from './vitest.hosted-input-preparation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_CHANNEL_MUTATION
if (mutation && !['per-request', 'no-preparation'].includes(mutation)) throw Error('Unknown channel preparation mutation')
export default defineConfig({
  resolve: preparation.resolve, cacheDir: '.cache/desktop-host-channel',
  plugins: [{ name: 'actual-channel-preparation-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id)
    if (!['packages/core/src/public-rpc-client.ts', 'apps/desktop/src/main/desktop-host.ts'].includes(path)) return
    let code = source
    const replacement = mutation === 'per-request' && path.endsWith('/desktop-host.ts')
      ? ['call: rpc.call.bind(rpc),', 'call: async (method, params, options) => { await ensureHost(store.path, socketPath, configuration); return await rpc.call(method, params, options) },']
      : mutation === 'no-preparation' && path.endsWith('/public-rpc-client.ts')
        ? ['await this.prepareUnix(lifetime.signal)', 'await Promise.resolve()'] : undefined
    if (replacement) {
      if (source.split(replacement[0]!).length !== 2) throw Error('Expected one production channel preparation mutation')
      code = source.replace(replacement[0]!, replacement[1]!)
    }
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_CHANNEL_LOADED) appendFileSync(process.env.AGENTMUX_CHANNEL_LOADED,
      JSON.stringify({ path, original: digest(source), loaded: digest(code), mutation: replacement ? mutation : null }) + '\n')
    return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/desktop-host-channel.test.ts', 'apps/desktop/test/hosted-input-preparation.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false,
    testTimeout: 15000, hookTimeout: 15000, passWithNoTests: false }
})
