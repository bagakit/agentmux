import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { path: string; from: string; to: string }> = {
  'freeze-placeholder': { path: 'apps/desktop/src/renderer/src/components/AgentInputRecap.tsx', from: 'Boolean(reader.conversation.snapshot) && (!reader.loading || reader.messages.length > 0)', to: 'true' },
  'skip-initial': { path: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', from: 'demand.batches < 3 && !view.error', to: 'false && !view.error' },
  'unbounded-initial': { path: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', from: 'demand.batches < 3 && !view.error', to: 'demand.batches < 30 && !view.error' },
  'displace-current': { path: 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', from: 'view.earlier(undefined, { preserveCurrent: true })', to: 'view.earlier()' },
  'keep-loading-cut': { path: 'apps/desktop/src/renderer/src/components/AgentInputRecap.tsx', from: 'setFrozen({ ...frozen, loading: false, error: current.error, observationError: current.observationError, sourceChanged: current.sourceChanged })', to: 'void 0' }
}
export default defineConfig({ ...base, cacheDir: resolve(root, '.tmp/recent-inputs-cache'),
  plugins: [...base.plugins ?? [], { name: 'recent-inputs-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/') && !path.startsWith('apps/desktop/test/')) return
    let code = source
    const mutation = process.env.AGENTMUX_RECENT_INPUTS_MUTATION
    if (mutation) {
      const edit = mutations[mutation]
      if (!edit) throw Error('Unknown recent inputs mutation')
      if (path === edit.path) {
        if (source.split(edit.from).length !== 2) throw Error('Non-unique recent inputs mutation')
        code = source.replace(edit.from, edit.to)
      }
    }
    const log = process.env.AGENTMUX_RECENT_INPUTS_LOADED
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (log) appendFileSync(log, JSON.stringify({ path, sourceSha256: sha(source), loadedSha256: sha(code), mutated: code !== source }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/agent-input-initial-frame.test.tsx', 'apps/desktop/test/agent-input-protected-cost.test.tsx',
    'apps/desktop/test/conversation-input-entity-recap.test.tsx', 'apps/desktop/test/agent-input-bounded-reading.test.tsx'], passWithNoTests: false }
})
