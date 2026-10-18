import base from '../../desktop/test/vitest.input-mailbox-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const mailbox = resolve(import.meta.dirname, '../src/conversation/MobileMailbox.tsx')
const surface = resolve(import.meta.dirname, '../src/conversation/MobileConversationSurface.tsx')
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...base, cacheDir: '.cache/mobile-input-groups', plugins: [{
  name: 'mobile-original-input-consumer', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (file !== mailbox && file !== surface) return
    let code = source
    const mutation = process.env.AGENTMUX_MOBILE_INPUTS_MUTATION
    const changes: Record<string, [string, string]> = {
      'raw-inputs': ['messages: groupedMessages', 'messages: history.messages'],
      'drop-originals': ['return <InputHistoryOriginalRecords messages={messages ?? []} {...historyActions} />', 'return null'],
      'execution-host-route': ["const hostId = 'local'", "const hostId = session?.hostId ?? ''"],
      'discard-reading': ['const selectedOriginal = selection?.scope === historyScope ? selection.message : null', 'const selectedOriginal = null as AgentSessionUserMessage | null'],
      'ignore-consensus': ['inputGroup={item => mailboxGroups.get(inputMailboxItemKey(hostId, item))}', 'inputGroup={() => undefined}'],
      'duplicate-copy': ['<ConversationMessage {...reading} copyInParent', '<ConversationMessage {...reading}'],
      'retain-other-host': ['<MobileMailbox key={historyConnection.current.generation} client={client}', '<MobileMailbox client={client}']
    }
    if (mutation && file === (mutation === 'retain-other-host' ? surface : mailbox)) {
      const change = changes[mutation]
      if (!change || source.split(change[0]).length !== 2) throw Error('Unknown or non-unique Mobile input mutation: ' + mutation)
      code = source.replace(...change)
    }
    const log = process.env.AGENTMUX_UNIFIED_LOADED
    if (log) appendFileSync(log, JSON.stringify({ path: relative(root, file), bytes: Buffer.byteLength(code),
      sha256: createHash('sha256').update(code).digest('hex'), originalSHA256: createHash('sha256').update(source).digest('hex'), ...(code !== source ? { mutation } : {}) }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}, ...base.plugins!], test: { ...base.test, setupFiles: ['apps/mobile/test/device-locks.ts'], include: [
  'apps/mobile/test/mobile-input-groups.test.tsx', 'apps/mobile/test/mobile-input-history.test.tsx'
] } })
