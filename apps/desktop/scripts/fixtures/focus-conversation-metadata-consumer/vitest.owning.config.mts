import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, readonly [string, string, string]> = {
  'drop-controlled-props': ['components/FocusMessagePreview.tsx',
    'describeSpeaker={describeSpeaker} inputSource={message.source} conversationSessionId={message.agentSessionId}', ''],
  'borrow-recipient-project': ['components/RecentFocusTimeline.tsx',
    '...(metadata.project ? { project: metadata.project } : {}),',
    '...(() => { const recipient = currentConversationSpeakerMetadata(inputContextId ?? "", { sessions: state.sessions, workspaces: state.config?.workspaces ?? [], agentNames: state.agentNames, timelines: state.timelines }); return recipient?.project ? { project: recipient.project } : {} })(),'],
  'eager-goals': ['components/RecentFocusTimeline.tsx', 'return metadata ? {',
    'if (metadata) currentConversationSenderDetails(id, { sessions: state.sessions, workspaces: state.config?.workspaces ?? [], agentNames: state.agentNames, timelines: state.timelines, demands: state.demands }); return metadata ? {']
}
export default defineConfig({ ...base, root, esbuild: { jsx: 'automatic' },
  cacheDir: resolve(root, '.tmp/focus-conversation-metadata-vitest-cache'),
  plugins: [...(base.plugins ?? []), { name: 'actual-focus-conversation-metadata-consumer', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0]!
    if (!file.startsWith(`${root}/apps/desktop/src/`) || !/\.[cm]?[jt]sx?$/u.test(file)) return
    const before = code, mutation = process.env.AGENTMUX_FOCUS_METADATA_MUTATION
    if (mutation) {
      const change = mutations[mutation]; if (!change) throw new Error(`Unknown metadata mutation ${mutation}`)
      if (file === `${root}/apps/desktop/src/renderer/src/${change[0]}`) {
        if (code.split(change[1]).length !== 2) throw new Error(`Missing unique actual metadata mutation ${mutation}`)
        code = code.replace(change[1], change[2])
      }
    }
    const output = process.env.AGENTMUX_FOCUS_METADATA_LOADED_SOURCE
    if (output) appendFileSync(output, JSON.stringify({ path: relative(root, file),
      originalSHA256: createHash('sha256').update(before).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'),
      bytes: Buffer.byteLength(code), ...(code !== before ? { mutation } : {}) }) + '\n')
    if (code !== before) return { code, map: null }
  }}],
  test: { ...base.test, include: ['apps/desktop/test/focus-conversation-metadata-consumer.test.tsx'], passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1, testTimeout: 15_000 }
})
