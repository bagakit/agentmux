import base from './vitest.conversation-unified-consumers.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutations: Record<string, { file: string; from: string; to: string }> = {
  'guess-author': { file: 'packages/client-ui/src/components/ConversationMessage.tsx', from: "conversationEvent?.role === 'observation' ? '作者未记录'", to: "conversationEvent?.role === 'observation' ? 'Assistant'" },
  'order-as-association': { file: 'packages/client-ui/src/components/ConversationSourceLabels.tsx', from: '    {sources?.unread ?', to: '    {sources?.labels.length === 1 ? <span>跨来源关联未确认</span> : null}\n    {sources?.unread ?' },
  'erase-unread': { file: 'packages/client-ui/src/lib/conversation-sources.ts', from: "${unreadTarget ? '对应的原始记录尚未读到。'", to: "${false ? '对应的原始记录尚未读到。'" },
  'erase-event': { file: 'packages/client-ui/src/lib/conversation-sources.ts', from: "...(eventName ? [`原事件：${eventName}`] : [])", to: '...[]' }
}
export default defineConfig({ ...base, cacheDir: '.cache/conversation-evidence-labels-' + (process.env.AGENTMUX_EVIDENCE_LABEL_MUTANT ?? 'baseline'), plugins: [{ name: 'evidence-label-source-mutation', enforce: 'pre', transform(source, id) {
  const file = relative(root, id.split('?')[0]!), name = process.env.AGENTMUX_EVIDENCE_LABEL_MUTANT, mutation = name ? mutations[name] : undefined
  if (name && !mutation) throw Error('Unknown evidence-label mutation')
  if (mutation?.file !== file) return
  if (source.split(mutation.from).length !== 2) throw Error('Missing unique actual source mutation')
  const code = source.replace(mutation.from, mutation.to)
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  if (process.env.AGENTMUX_EVIDENCE_LABEL_LOADED) appendFileSync(process.env.AGENTMUX_EVIDENCE_LABEL_LOADED, JSON.stringify({ file, name, originalSHA256: hash(source), mutatedSHA256: hash(code) }) + '\n')
  return { code, map: null }
} }, ...base.plugins ?? []], test: { ...base.test, include: [
  'apps/desktop/test/conversation-evidence-labels.test.tsx', 'apps/desktop/test/conversation-collected-reply.test.tsx',
  'apps/desktop/test/conversation-source-labels.test.tsx', 'apps/desktop/test/conversation-source-roles.test.tsx',
  'apps/desktop/test/conversation-submission-presentation.test.tsx'
], passWithNoTests: false } })
