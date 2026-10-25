import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_OUTCOME_UI_MUTATION
export const mutations: Record<string, [string, string, string]> = {
  'drop-card': ['packages/client-ui/src/components/ConversationView.tsx', "return outcome?.status === 'failed' ?", 'return false ?'],
  'fold-failure': ['packages/client-ui/src/lib/conversation-record-sequence.ts', "if (conversationRecordTurnOutcome(record)?.status === 'failed')", 'if (false)'],
  'replace-original-message': ['packages/client-ui/src/components/ConversationTurnFailure.tsx', '{failure.message}', "{failure.publicMessage ?? 'Failure'}"],
  'lose-deferred-outcome': ['packages/client-ui/src/lib/conversation-records.ts', "record.original.kind === 'deferred' ? record.original.item.item.turnOutcome", "record.original.kind === 'deferred' ? undefined"]
}
if (mutation && !mutations[mutation]) throw Error('Unknown outcome UI mutation')
export default defineConfig({ ...base, cacheDir: '.cache/provider-outcome-ui', plugins: [...base.plugins ?? [], {
  name: 'provider-outcome-ui-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/client-ui/src/') && !path.startsWith('packages/core/src/')) return
    const selected = mutation ? mutations[mutation] : undefined
    let code = source
    if (selected?.[0] === path) {
      if (source.split(selected[1]).length !== 2) throw Error('Outcome UI mutation anchor is not unique: ' + mutation)
      code = source.replace(selected[1], selected[2])
    }
    if (process.env.AGENTMUX_OUTCOME_UI_LOADED) appendFileSync(process.env.AGENTMUX_OUTCOME_UI_LOADED, JSON.stringify({ path,
      sha256: createHash('sha256').update(source).digest('hex'), mutation: code !== source ? mutation : null }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['packages/client-ui/test/provider-outcome.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 } })
