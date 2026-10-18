import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_MOTE_CHAT_PROFILE_MUTATION
if (mutation && !['fixed-interval', 'discard-unknown-input', 'allocate-wrong-total'].includes(mutation)) throw Error('Unknown Mote chat Profile mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/mote-private-chat-profile'),
  plugins: [{ name: 'original-mote-chat-profile-mutations', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/MotePrivateChat.tsx', 'apps/desktop/src/renderer/src/components/MoteChatPeople.tsx', 'apps/desktop/src/renderer/src/lib/mote-chat-request.ts'].includes(file)) return
    let code = source, applied: string | null = null
    const anchor = mutation === 'fixed-interval' && file.endsWith('/MotePrivateChat.tsx') ? 'conversationIdleMs: idle'
      : mutation === 'discard-unknown-input' && file.endsWith('/mote-chat-request.ts') ? 'if (!dispatched ||'
        : mutation === 'allocate-wrong-total' && file.endsWith('/MoteChatPeople.tsx') ? 'expectedPersonRevision: person.revision, total: count' : null
    if (anchor) {
      if (source.split(anchor).length !== 2) throw Error('Missing unique actual Profile consumer mutation')
      code = source.replace(anchor, mutation === 'fixed-interval' ? 'conversationIdleMs: MOTE_CHAT_DEFAULT_VALUES.conversationIdleMs'
        : mutation === 'discard-unknown-input' ? 'if (true ||' : 'expectedPersonRevision: person.revision, total: person.used'); applied = mutation!
    }
    if (process.env.AGENTMUX_MOTE_CHAT_PROFILE_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_MOTE_CHAT_PROFILE_LOADED, JSON.stringify({ file, originalSHA256: sha(source), sha256: sha(code), mutation: applied }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/mote-private-chat-profile.test.tsx'], fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
