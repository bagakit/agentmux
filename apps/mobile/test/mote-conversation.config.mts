import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './mote-principles.config.mts'
const variants: Record<string, { file: string; before: string; after: string }> = {
  'presence-interval': { file: '/src/navigation/MobileMoteQuickEditor.tsx', before: 'intervalMs: Number(value) * 60000', after: 'intervalMs: DEFAULT_MOTE_PRESENCE.intervalMs' },
  'paused-presentation': { file: '/src/navigation/MobileMoteQuickEditor.tsx', before: "paused: '原心跳安排已暂停'", after: "paused: '已安排自动心跳'" },
  'work-host-route': { file: '/src/conversation/MobileMoteConversation.tsx', before: 'hostId: source.origin.hostId, sourceMessageId: source.origin.messageId', after: "hostId: 'local', sourceMessageId: source.origin.messageId" },
  'work-host-receipt': { file: '/src/conversation/MobileMoteConversation.tsx', before: 'if (value.hostId !== source.origin.hostId)', after: 'if (false)' },
  'accepted-page-target': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'target={pageClient === client && pageSessionId === agentSessionId ? moteTarget : undefined}', after: 'target={moteTarget}' },
  'reader-main-return': { file: '/src/MobileApp.tsx', before: 'const main = original ?? moteDialogue.page?.main.current ?? team?.main?.reference', after: 'const main = teamReading.team?.main?.reference' },
  'main-public-intake': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: 'if (!original.moteMain) return source.submitAgentPrompt(input)', after: 'if (true) return source.submitAgentPrompt(input)' },
  'main-role-durable': { file: '/src/conversation/local-drafts.ts', before: '...(intent.moteMain ? { moteMain: structuredClone(intent.moteMain) } : {})', after: '...{}' },
  'main-exact-complete': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: "if (outcome !== 'admitted' && outcome !== 'terminal-confirmed') throw Object.assign(", after: 'if (false) throw Object.assign(' },
  'main-unknown-readonly': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: 'if (!observed && original.moteMain && original.inputRequested !== false)', after: 'if (false)' },
  'main-direct-member': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'moteDirectAgent ? undefined : observedMobileMoteMain', after: 'false ? undefined : observedMobileMoteMain' },
  'main-target-host': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: "if (original.moteMain && (originalSession.agentSessionId !== original.moteMain.reference.sessionId || originalSession.hostId !== original.moteMain.reference.hostId)) {\n          throw Object.assign", after: 'if (false) {\n          throw Object.assign' },
  'resume-durable': { file: '/src/navigation/useMoteQuickDraft.ts', before: 'const ack = await retain({ ...current.current, maintenanceAttempts: [...current.current.maintenanceAttempts ?? [], operation] })', after: 'const ack = { canForward: true }' },
  'resume-unknown-readonly': { file: '/src/navigation/useMoteQuickDraft.ts', before: "await original.forwardRpc('schedule.inspect', { operationId: input.operationId }, {}, fence)", after: "await original.forwardRpc('schedule.resume', input, {}, fence)" },
  'resume-runtime-scope': { file: '/src/navigation/useMoteQuickDraft.ts', before: 'moteQuickDraftKey(selected.scope) !== moteQuickDraftKey(source.scope)', after: 'false' },
  'stopped-presentation': { file: '/src/navigation/MobileMoteQuickEditor.tsx', before: "{maintenance?.schedule?.status === 'paused' && <button", after: "{maintenance?.status === 'paused' && <button" },
  'reply-render-key': { file: '/components/MoteConversationThreads.tsx', before: 'return <section key={source.sequence}>', after: 'return <section key={value.source.envelope.messageId}>' },
  'reply-source-host': { file: '/components/MoteConversationThreads.tsx', before: 'return { source, value }', after: 'return { source: event.sources.find(item => item.origin.messageId === source.origin.messageId)!, value }' },
  'reply-unknown-name': { file: '/components/MoteConversationThreads.tsx', before: 'sender === source.origin.recipientSessionId ? memberName?.(source) ?? sender : sender', after: 'true ? memberName?.(source) ?? sender : sender' },
  'earlier-main-avatar': { file: '/components/MoteConversationThreads.tsx', before: '...(mainAvatar ? { avatar: mainAvatar(size) } : {})', after: '...{}' },
  'unconfirmed-main-badge': { file: '/src/MobileApp.tsx', before: "confirmed: main.status === 'ready' && !moteDialogue.unavailable", after: 'confirmed: true' }
}
const name = process.env.AGENTMUX_MOBILE_DIALOGUE_MUTATION
if (name && !variants[name]) throw Error('Unknown Mobile dialogue source mutation')
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], { name: 'loaded-mobile-dialogue-source', enforce: 'pre', transform(code, id) {
  const mutation = name && variants[name]
  if (!mutation || !id.split('?')[0]!.endsWith(mutation.file)) return
  if (code.split(mutation.before).length !== 2) throw Error('Original Mobile source mutation anchor changed: ' + name)
  const changed = code.replace(mutation.before, mutation.after), trace = process.env.AGENTMUX_MOBILE_DIALOGUE_TRACE
  if (!trace) throw Error('Original loaded production trace is required')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  appendFileSync(trace, JSON.stringify({ name, file: id.split('?')[0], before: sha(code), after: sha(changed) }) + '\n')
  return changed
} }], test: { ...base.test, include: ['test/mote-presence-settings.test.tsx', 'test/mobile-mote-dialogue.test.tsx', 'test/mote-dialogue-projection.test.tsx'], testTimeout: 20000 } })
