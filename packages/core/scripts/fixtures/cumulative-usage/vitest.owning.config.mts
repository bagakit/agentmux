import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations = {
  cumulative: ['packages/core/src/agent-session-store.ts', '...(cumulative ? { cumulative } : {}),', ''],
  wire: ['packages/core/src/rpc-native-codec.ts', 'usage.cumulative !== undefined && !isDeepStrictEqual(usage.cumulative, session.turnUsage?.cumulative)', 'false']
} as const
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/agent-information-card/core-vitest-cache'),
  plugins: [{ name: 'original-cumulative-usage-consumer', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') && !path.startsWith('packages/core/test/agent-usage-') && path !== 'packages/core/test/agent-cumulative-usage.test.ts') return
    const mutation = process.env.AGENTMUX_USAGE_MUTATION as keyof typeof mutations | undefined
    let served = code
    if (mutation && mutations[mutation][0] === path) {
      const [, needle, replacement] = mutations[mutation]
      if (code.split(needle).length !== 2) throw new Error('Mutation must match the original consumer exactly once: ' + mutation)
      served = code.replace(needle, replacement)
    }
    if (process.env.AGENTMUX_USAGE_LOADED) appendFileSync(process.env.AGENTMUX_USAGE_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: served !== code }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { include: ['packages/core/test/agent-cumulative-usage.test.ts', 'packages/core/test/agent-usage-transcript.test.ts',
    'packages/core/test/agent-usage-capability.test.ts', 'packages/core/test/agent-usage-env-injection.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1 }
})
