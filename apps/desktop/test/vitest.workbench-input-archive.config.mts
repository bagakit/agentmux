import { defineConfig } from 'vitest/config'
import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'

const mutations = {
  'read-before-inputs': ['components/SessionMailbox.tsx', "archiveOwner && open && visible && documentVisible && folder === 'user'", 'archiveOwner'],
  'share-source-owner': ['components/AgentSessionComposer.tsx', '{ ownerKey, present: presentQueueEntry }', '{ ownerKey: sessionId, present: presentQueueEntry }'],
  'omit-cli-archive': ['store.ts', 'messages: [...messages, ...archived.filter(message => !activeIds.has(message.pendingId))]', 'messages'],
} as const
const mutation = process.env.AGENTMUX_INPUT_ARCHIVE_MUTATION
const selected = mutation ? mutations[mutation as keyof typeof mutations] : undefined
if (mutation && !selected) throw Error(`Unknown input archive mutation: ${mutation}`)

export default defineConfig({ ...base, cacheDir: '.tmp/workbench-input-archive-cache',
  plugins: [...base.plugins ?? [], { name: 'workbench-input-archive-mutation', enforce: 'pre', transform(code, id) {
    if (!selected) return
    const [path, original, replacement] = selected
    if (!id.split('?')[0]!.endsWith('/apps/desktop/src/renderer/src/' + path)) return
    if (code.split(original).length !== 2) throw Error(`Input archive mutation anchor must occur once: ${mutation}`)
    return code.replace(original, replacement)
  } }],
  test: { ...base.test, include: ['apps/desktop/test/workbench-input-archive.test.tsx'], maxWorkers: 1, passWithNoTests: false }
})
