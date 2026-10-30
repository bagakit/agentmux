import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './mote-principles.config.mts'
const variants: Record<string, { file: string; before: string; after: string }> = {
  'setup-retain-followup': { file: '/src/navigation/MobileMoteMainActions.tsx', before: "(device.agentCreates ?? []).filter(item => item.runtimeId", after: "(device.agentCreates ?? []).filter(item => item.phase !== 'confirmed').filter(item => item.runtimeId" },
  'setup-no-repeat': { file: '/src/navigation/MobileMoteMainActions.tsx', before: "setReading(null); onBound(); refresh(value => value + 1)", after: 'setReading(null); onBound()' },
  "known-main-new-input": { file: "/src/conversation/use-mobile-prompt-controller.ts", before: "if (!originalBody && !moteDirectAgent && moteMainIssue &&", after: "if (false &&" },
  "threads-visibility": { file: "/src/MobileApp.tsx", before: "visible={exposed && threadsVisible}", after: "visible={false}" },
  "setup-durable": { file: "/src/navigation/MobileMoteMainActions.tsx", before: "await owner.retainAgentCreate(intent, recordId)", after: "await Promise.resolve()" },
  "setup-inspect-readonly": { file: "/src/navigation/MobileMoteMainActions.tsx", before: "action === 'inspect' ? 'space.mote.dialogue.setup.inspect' : 'space.mote.dialogue.setup.advance'", after: "action === 'inspect' ? 'space.mote.dialogue.setup.advance' : 'space.mote.dialogue.setup.advance'" },
  "setup-owner-host": { file: "/src/navigation/MobileMoteMainActions.tsx", before: "const input = { target, creation: { hostId: 'local', operationId: id } }", after: "const input = { target, creation: { hostId: target.expectedResource.hostId, operationId: id } }" },
  "setup-configured-executor": { file: "/src/navigation/MobileMoteMainActions.tsx", before: "item.id === reading.preferences.defaults?.executorId", after: "true" },
  'presence-interval': { file: '/src/navigation/MobileMoteQuickEditor.tsx', before: 'intervalMs: Number(value) * 60000', after: 'intervalMs: DEFAULT_MOTE_PRESENCE.intervalMs' },
  'paused-presentation': { file: '/src/navigation/MobileMoteQuickEditor.tsx', before: "paused: '原心跳安排已暂停'", after: "paused: '已安排自动心跳'" },
  'work-host-route': { file: '/src/navigation/MobileMoteThreads.tsx', before: 'hostId: source.origin.hostId, sourceMessageId: source.origin.messageId', after: "hostId: 'local', sourceMessageId: source.origin.messageId" },
  'work-host-receipt': { file: '/src/navigation/MobileMoteThreads.tsx', before: 'if (value.hostId !== source.origin.hostId)', after: 'if (false)' },
  'accepted-page-target': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'target={!moteDirectAgent && pageClient === client && pageSessionId === agentSessionId ? moteTarget : undefined}', after: 'target={moteTarget}' },
  'reader-main-return': { file: '/src/MobileApp.tsx', before: "const main = original ?? (moteDialogue.page?.main.status === 'ready' && !moteDialogue.unavailable ? moteDialogue.page.main.current : team?.main?.reference)", after: 'const main = teamReading.team?.main?.reference' },
  'main-public-intake': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: 'if (!original.moteMain) return source.submitAgentPrompt(input)', after: 'if (true) return source.submitAgentPrompt(input)' },
  'main-role-durable': { file: '/src/conversation/local-drafts.ts', before: '...(intent.moteMain ? { moteMain: structuredClone(intent.moteMain) } : {})', after: '...{}' },
  'main-exact-complete': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: "if (outcome !== 'admitted' && outcome !== 'terminal-confirmed') throw Object.assign(", after: 'if (false) throw Object.assign(' },
  'main-unknown-readonly': { file: '/src/conversation/use-mobile-prompt-controller.ts', before: 'if (!observed && original.moteMain && original.inputRequested !== false)', after: 'if (false)' },
  'main-direct-member': { file: '/src/conversation/MobileConversationSurface.tsx', before: 'moteDirectAgent ? undefined : retainMobileMoteMain', after: 'false ? undefined : retainMobileMoteMain' },
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
