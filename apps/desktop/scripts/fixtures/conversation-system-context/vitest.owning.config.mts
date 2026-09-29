import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-chat-clarity-artifacts/system-context/cache'),
  plugins: [{ name: 'chat-identity-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || !/\.[jt]sx?$/u.test(file)) return
    const before = code, mutation = process.env.AGENTMUX_SYSTEM_CONTEXT_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'system-speaker-human': ['lib/conversation-speaker.ts', "return { role: 'system', id: AGENTMUX_SYSTEM_SPEAKER_ID }", "return { role: 'human', id: HUMAN_SPEAKER_ID }"],
      'system-skip-kind': ['lib/conversation-speaker.ts', "item.kind === 'system_message' && item.source === 'agentmux'", "item.source === 'agentmux'"],
      'system-folded-content': ['components/ConversationMessage.tsx', 'hasContent && (!isSystemContext || systemContextOpen)', 'hasContent']
    }
    const edit = mutation ? edits[mutation] : undefined
    if (edit && file === `${root}/apps/desktop/src/renderer/src/${edit[0]}`) {
      if (!code.includes(edit[1])) throw new Error(`Missing mutation target ${mutation}`)
      code = code.replaceAll(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_SYSTEM_CONTEXT_LOADED_SOURCE
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      bytes: Buffer.byteLength(code), ...(code === before ? {} : { mutation }) }) + '\n') }
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-system-context.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
