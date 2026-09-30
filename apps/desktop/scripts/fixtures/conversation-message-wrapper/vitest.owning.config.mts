import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-input-cards-artifacts/T008/cache'),
  plugins: [{ name: 'message-wrapper-loaded-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(`${root}/apps/desktop/src/renderer/src/`) || file === `${root}/packages/core/dist/agent-message-render.js`) || !/\.[jt]sx?$/u.test(file)) return
    const before = code, mutation = process.env.AGENTMUX_MESSAGE_WRAPPER_MUTATION
    const edits: Record<string, [string, string, string]> = {
      'wrapper-bypass': ['components/ConversationMessage.tsx', 'prefix?.packet ? prefix.packet.parts.map', 'false ? prefix!.packet!.parts.map'],
      'packet-name-author': ['components/ConversationMessage.tsx', ': displayName}</span>', ': prefix?.packet?.name ?? displayName}</span>'],
      'packet-time-recorded': ['components/ConversationMessage.tsx', '{renderClock(createdAt)}', '{prefix?.packet?.time ?? renderClock(createdAt)}'],
      'copy-body-only': ['components/ConversationMessage.tsx', "const text = parts.map(partText).filter((t) => t.length > 0).join('\\n')", "const text = prefix?.body ?? parts.map(partText).filter((t) => t.length > 0).join('\\n')"],
      'native-parser-missing': ['components/ConversationMessage.tsx', "isIncoming && parts[0]?.kind === 'text'", "isIncoming && inputSource?.kind !== 'native' && parts[0]?.kind === 'text'"]
    }
    const edit = mutation ? edits[mutation] : undefined
    if (edit && file === `${root}/apps/desktop/src/renderer/src/${edit[0]}`) {
      if (!code.includes(edit[1])) throw new Error(`Missing mutation target ${mutation}`)
      code = code.replaceAll(edit[1], edit[2])
    }
    const log = process.env.AGENTMUX_MESSAGE_WRAPPER_LOADED_SOURCE
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      bytes: Buffer.byteLength(code), ...(code === before ? {} : { mutation }) }) + '\n') }
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-message-wrapper.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
