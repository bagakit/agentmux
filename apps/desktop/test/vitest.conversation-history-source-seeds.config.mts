import base from './vitest.conversation-unified-consumers.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
const root = resolve(import.meta.dirname, '../../..')
const targets = {
  'entity-composer-seeds': { path: 'apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', from: 'native.sourceMessages.length ? native.sourceMessages : EMPTY_MESSAGES', to: 'native.messages.length ? native.messages : EMPTY_MESSAGES' },
  'entity-mobile-seeds': { path: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', from: 'reading.projection?.originalRecords.flatMap(record => record.input ? [record.input] : []) ?? []', to: 'reading.projection?.inputs ?? []' }
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-history-source-seeds',
  plugins: [...base.plugins ?? [], { name: 'conversation-history-seed-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!['packages/core/src/conversation.ts', 'apps/desktop/src/renderer/src/lib/session-user-messages.ts', 'apps/desktop/src/renderer/src/lib/use-composer-input-history.tsx', 'packages/client-ui/src/lib/use-agent-input-history.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx', 'apps/mobile/src/conversation/MobileMailbox.tsx'].includes(path)) return
    const mutation = process.env.AGENTMUX_HISTORY_SEED_MUTATION as keyof typeof targets | undefined
    let code = source
    if (mutation) {
      const edit = targets[mutation]
      if (!edit) throw Error('Unknown history-seed mutation')
      if (path === edit.path) {
        if (source.split(edit.from).length !== 2) throw Error('Missing unique history-seed mutation target')
        code = source.replace(edit.from, edit.to)
      }
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_HISTORY_SEED_LOADED) appendFileSync(process.env.AGENTMUX_HISTORY_SEED_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), bytes: Buffer.byteLength(code), ...(code === source ? {} : { mutation }) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }],
  test: { ...base.test, include: ['apps/desktop/test/conversation-history-source-seeds.test.tsx'], exclude: [], passWithNoTests: false, fileParallelism: false, testTimeout: 15000 } })
