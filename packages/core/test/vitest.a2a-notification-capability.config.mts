import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from './vitest.a2a-idle-input.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_NOTIFICATION_CAPABILITY_MUTATION
const mutations = {
  'missing-transport-silenced': { file: 'client.ts', before: 'if (!provider.prepareNativeInput) return { ...observation, unavailable:', after: 'if (false) return { ...observation, unavailable:' },
  'diagnostic-repeat': { file: 'agent-message-notifications.ts', before: 'if (this.unavailableReads.get(agentSessionId) !== failure)', after: 'if (true)' },
  'diagnostic-recovery-stuck': { file: 'agent-message-notifications.ts', before: '    this.unavailableReads.delete(agentSessionId)\n', after: '' },
  'diagnostic-run-omitted': { file: 'client.ts', before: 'evidence: { source: \'agentmux\', observedAt: Date.now(), ...(run ? { run } : {}) }', after: 'evidence: { source: \'agentmux\', observedAt: Date.now() }' },
  'explicit-recovery-disabled': { file: 'client.ts', before: ": { ...base, expectedRun: notice.key.expectedRun, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' }", after: ": { ...base, expectedRun: notice.key.expectedRun, admissionIntent: { kind: 'manual-actor' }, execution: 'default' }" }
} as const
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error('Unknown A2A notification capability mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), {
  name: 'a2a-notification-capability-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(root + '/') || file.includes('/node_modules/')) return
    let code = source
    const selected = mutation ? mutations[mutation as keyof typeof mutations] : undefined
    if (selected && file === resolve(root, 'packages/core/src', selected.file)) {
      if (source.split(selected.before).length !== 2) throw new Error('Notification mutation must match one actual Core branch')
      code = source.replace(selected.before, selected.after)
    }
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_NOTIFICATION_CAPABILITY_LOADED) appendFileSync(process.env.AGENTMUX_NOTIFICATION_CAPABILITY_LOADED,
      JSON.stringify({ path: relative(root, file), original: hash(readFileSync(file)), mutated: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}],
  test: { ...base.test, environment: 'node', include: ['packages/core/test/a2a-notification-capability.test.ts'] }
})
