import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import shared from '../workbench-identity/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations = {
  consumer: ['apps/desktop/src/renderer/src/components/AgentContextUsage.tsx', '<AgentUsageDetails usage={usage} />', 'null'],
  cumulative: ['apps/desktop/src/renderer/src/components/AgentUsageDetails.tsx', '<TokenCounts usage={usage.cumulative} />', '<TokenCounts usage={usage} />'],
  context: ['apps/desktop/src/renderer/src/components/AgentUsageDetails.tsx', 'contextUsedPercent(context)', 'contextUsedPercent(usage?.cumulative ? { ...context!, usedTokens: usage.cumulative.totalTokens } : context)']
} as const
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/agent-information-card/usage-ui-vitest-cache'),
  plugins: [...shared.plugins ?? [], { name: 'actual-agent-usage-details', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !['apps/desktop/test/agent-context-hover.test.tsx', 'apps/desktop/test/agent-usage-details.test.tsx'].includes(path)) return
    let served = code
    const mutation = process.env.AGENTMUX_USAGE_UI_MUTATION as keyof typeof mutations | undefined
    if (mutation && mutations[mutation][0] === path) {
      const [, needle, replacement] = mutations[mutation]
      if (code.split(needle).length !== 2) throw new Error('Mutation must match one original actual consumer: ' + mutation)
      served = code.replace(needle, replacement)
    }
    if (process.env.AGENTMUX_USAGE_UI_LOADED) appendFileSync(process.env.AGENTMUX_USAGE_UI_LOADED, JSON.stringify({ path,
      sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: code !== served }) + '\n')
    return code !== served ? { code: served, map: null } : undefined
  } }], test: { ...shared.test, include: ['apps/desktop/test/agent-context-hover.test.tsx', 'apps/desktop/test/agent-usage-details.test.tsx'],
    passWithNoTests: false }
})
