import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'

const mutant = process.env.AGENTMUX_POLICY_EFFECT_MUTANT
const edits: Record<string, [string, string, string]> = {
  automation: ['apps/desktop/src/renderer/src/components/settings/AutomationDefaultsSettingsPane.tsx', 'try { parsed = policyValue(draft.value) }', 'try { parsed = policyValue(editValue(saved)) }'],
  recovery: ['apps/desktop/src/renderer/src/components/settings/ContinuitySettingsPane.tsx', '<RetryExample policy={parsed} />', '<RetryExample policy={executionSettings(saved)} />'],
  delay: ['packages/core/src/agent-session-recovery/continuity.ts', 'policy.retryInitialDelayMs * 2 ** Math.min(retry - 1, 52)', 'policy.retryInitialDelayMs']
}
if (mutant && !edits[mutant]) throw new Error('Unknown policy effect mutation')
export default defineConfig({ root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'settings-policy-effects', enforce: 'pre', resolveId: installedDependency, transform(source, id) {
    if (!mutant || id.split('?')[0] !== resolve(root, edits[mutant]![0])) return
    const [file, before, after] = edits[mutant]!
    if (source.split(before).length !== 2) throw new Error('Expected one policy effect owner anchor')
    const changed = source.replace(before, after)
    if (process.env.AGENTMUX_POLICY_EFFECT_EVIDENCE) appendFileSync(process.env.AGENTMUX_POLICY_EFFECT_EVIDENCE, JSON.stringify({
      mutant, file, original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(changed).digest('hex')
    }) + '\n')
    return { code: changed, map: null }
  } }],
  test: { include: ['apps/desktop/test/settings-policy-effects.test.tsx', 'packages/core/test/agent-continuity-retry-delay.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
