import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-chat-clarity-artifacts/T001/cache'),
  plugins: [{ name: 'chat-identity-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[jt]sx?$/u.test(file)) return
    const before = code, mutation = process.env.AGENTMUX_CHAT_IDENTITY_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'unknown-appearance': ['lib/conversation-speaker.ts', "return speaker.role === 'unknown' ? { role: 'human', id: HUMAN_SPEAKER_ID } : speaker", 'return speaker'],
      'peer-identity': ['components/ConversationMessage.tsx', 'speaker.id !== conversationSessionId', 'speaker.id === conversationSessionId'],
      'activity-context': ['components/ActivityView.tsx', 'conversationSessionId={sessionId}', 'conversationSessionId=""']
    }
    const edit = mutation ? edits[mutation] : undefined
    if (edit && file === `${root}/apps/desktop/src/renderer/src/${edit[0]}`) {
      if (!code.includes(edit[1])) throw new Error(`Missing mutation target ${mutation}`)
      code = code.replaceAll(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_CHAT_IDENTITY_LOADED_SOURCE
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      bytes: Buffer.byteLength(code), ...(code === before ? {} : { mutation }) }) + '\n') }
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-chat-identity.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
