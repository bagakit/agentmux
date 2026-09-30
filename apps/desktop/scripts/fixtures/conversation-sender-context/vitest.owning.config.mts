import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.bagakit/feature-tracker/conversation-input-cards-artifacts/T002/cache'),
  plugins: [...(original.plugins ?? []), { name: 'sender-context-actual-source', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!(file.startsWith(`${root}/apps/desktop/src/`) || file.startsWith(`${root}/packages/core/dist/`)) || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const before = code
    const mutation = process.env.AGENTMUX_CONVERSATION_SENDER_MUTATION
    const edits: Record<string, { path: string; from: string; to: string; extraImport?: string }> = {
      'native-source-omitted': { path: 'components/ActivityView.tsx', from: 'inputSource={entry.message.source}', to: 'inputSource={undefined}' },
      'header-author-claimed': { path: 'components/ConversationMessage.tsx', from: 'source={inputSource} speaker={recordedSpeaker}', to: "source={inputSource} speaker={prefix?.declaredAgentSessionId ? { role: 'agent', id: prefix.declaredAgentSessionId } : recordedSpeaker}" },
      'ended-from-updated': { path: 'components/ConversationInputDetails.tsx', from: '<dt>Lifecycle end</dt><dd>Not recorded</dd>', to: '<dt>Lifecycle end</dt><dd>{new Date(useAppStore.getState().sessions.find(session => session.id === details.sessionId)!.updatedAt).toLocaleString()}</dd>', extraImport: "import { useAppStore } from '../store'\n" },
      'closed-project-icon': { path: 'components/ConversationInputDetails.tsx', from: '>Message details</button>', to: '>Message details</button><ProjectIcon workspaceId="sender-project" name="Closed mutation" />' },
      'unlinked-goal': { path: 'lib/conversation-sender-details.ts', from: '.filter((goal) => goal.sessionIds.includes(sender.id))', to: '.filter(() => true)' }
    }
    const edit = mutation ? edits[mutation] : undefined
    if (mutation && !edit) throw new Error(`Unknown sender Source mutation ${mutation}`)
    if (edit && file === `${root}/apps/desktop/src/renderer/src/${edit.path}`) {
      if (before.split(edit.from).length !== 2) throw new Error(`Missing unique sender mutation target ${mutation}`)
      code = (edit.extraImport ?? '') + before.replace(edit.from, edit.to)
    }
    const log = process.env.AGENTMUX_CONVERSATION_SENDER_LOADED_SOURCE
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) }) + '\n'); if (code !== before) writeFileSync(`${log}.${file.split('/').at(-1)}.transformed.txt`,code) }
    if (code !== before) return { code, map: null }
  } }, { name: 'sender-context-compiled-source', enforce: 'post', transform(code, id) {
    const file = id.split('?')[0]!, log = process.env.AGENTMUX_CONVERSATION_SENDER_LOADED_SOURCE
    if (!log || !['ConversationMessage.tsx', 'SessionPane.tsx', 'SessionHistoryView.tsx', 'ActivityView.tsx', 'conversation-speaker.ts'].some(name => file.endsWith(`/${name}`))) return
    const output = `${log}.${file.split('/').at(-1)}.compiled.js`; writeFileSync(output, code); appendFileSync(`${log}.compiled.jsonl`, JSON.stringify({ path: relative(root,file), output, bytes: Buffer.byteLength(code), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
  } }],
  test: { ...original.test, include: ['apps/desktop/test/conversation-sender-context.integration.test.tsx'], passWithNoTests: false, fileParallelism: false }
})
