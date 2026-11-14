import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './mote-settings-robustness.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.AGENTMUX_MOTE_CHAT_PROFILE_MUTATION
const connectionMutations: Record<string, { file: string; before: string; after: string }> = {
  'borrow-settings-host': { file: 'MotePrivateChat.tsx', before: 'owner = source === undefined ? originalOwner ?? await api.connections.hostingTarget() : await api.connections.hostingTarget(source)', after: 'owner = source === undefined ? useAppStore.getState().manualConnectionSelections.lark ?? originalOwner ?? await api.connections.hostingTarget() : await api.connections.hostingTarget(source)' },
  'discover-retained-owner': { file: 'MotePrivateChat.tsx', before: 'async function read(source?: string, originalDraft?: PolicyDraft) {', after: "async function read(source?: string, originalDraft?: PolicyDraft) { source ??= 'local'" },
  'ignore-explicit-source': { file: 'MotePrivateChat.tsx', before: ': await api.connections.hostingTarget(source)', after: ': await api.connections.hostingTarget()' },
  'adopt-late-source': { file: 'MotePrivateChat.tsx', before: 'if (ownerChanged && (hostingTarget || originals.length) && edited.current !== editRevision)', after: 'if (false && ownerChanged && (hostingTarget || originals.length) && edited.current !== editRevision)' },
  'cross-source-pending': { file: 'MotePrivateChat.tsx', before: '&& hostingKey(intent.hostingTarget) === hostingKey(hostingTarget)', after: '' },
  'discard-policy-draft': { file: 'MotePrivateChat.tsx', before: 'if (savedDraft) { usePolicyDraft(', after: 'if (false && savedDraft) { usePolicyDraft(' },
  'cross-source-allowance-pending': { file: 'MoteChatPeople.tsx', before: '&& intent.hostingTarget?.hostId === hostingTarget.hostId && intent.hostingTarget.runtimeId === hostingTarget.runtimeId', after: '' },
  'discard-allowance-draft': { file: 'MoteChatPeople.tsx', before: "retainedDraft = saved?.kind === 'allowance' ? saved : undefined", after: 'retainedDraft = undefined' },
  'global-request-busy': { file: 'MoteChatRequests.tsx', before: 'disabled={busy.has(intent.input.operationId) || !intent.hostingTarget}', after: 'disabled={busy.size > 0 || !intent.hostingTarget}' },
  'late-policy-ack-clears-draft': { file: 'MotePrivateChat.tsx', before: 'setMoteChatDraft(moteChatDraftKey(submittedDraft), undefined, submittedDraft.version)', after: 'setMoteChatDraft(moteChatDraftKey(submittedDraft), undefined)' },
  'late-allowance-ack-clears-draft': { file: 'MoteChatPeople.tsx', before: 'setMoteChatDraft(draftKey, undefined, originalDraft.version)', after: 'setMoteChatDraft(draftKey, undefined)' },
  'borrow-foreign-draft-slot': { file: 'mote-chat-draft.ts', before: 'restoredMoteChatDraft(value: unknown, expectedKey?: string): MoteChatDraft | undefined {', after: 'restoredMoteChatDraft(value: unknown, expectedKey?: string): MoteChatDraft | undefined { expectedKey = undefined' },
  'feedback-reversions-draft': { file: 'MoteChatPeople.tsx', before: 'retainTotal(current.total, message, current.version)', after: 'retainTotal(current.total, message)' },
  'leave-confirmed-draft': { file: 'MotePrivateChat.tsx', before: 'useLauncherState.getState().setMoteChatDraft(moteChatDraftKey(original), undefined, intent.input.operationId)', after: 'void intent.input.operationId' },
  'route-selected-to-lark': { file: 'App.tsx', before: 'if (section) navigateSettings({ section, moteConnectionOrigin })', after: "if (section) navigateSettings({ section: 'lark', moteConnectionOrigin })" },
  'drop-original-hosting': { file: 'App.tsx', before: 'if (section) navigateSettings({ section, moteConnectionOrigin })', after: 'if (section) navigateSettings({ section, moteConnectionOrigin: { ...moteConnectionOrigin, hostingTarget: null } })' },
  'block-unknown-creator': { file: 'MotePrivateChat.tsx', before: 'disabled={saving || pending}', after: 'disabled={saving || pending || !configuration?.creator}' },
  'detach-shared-editor': { file: 'MotePrivateChat.tsx', before: 'onClick={() => setExecutorOpen(true)}', after: 'onClick={() => setExecutorOpen(false)}' },
  'ordinary-save-refreshes-creator': { file: 'MotePrivateChat.tsx', before: 'values: { ...draft, conversationIdleMs: idle, strangerMessageLimit: limit } } })', after: 'values: { ...draft, conversationIdleMs: idle, strangerMessageLimit: limit }, refreshCreator: true } })' },
  'refresh-uses-guest-draft': { file: 'MotePrivateChat.tsx', before: 'values: original.values, refreshCreator: true', after: 'values: { ...draft, conversationIdleMs: Number(minutes) * 60000, strangerMessageLimit: Number(strangers) }, refreshCreator: true' },
  'refresh-omits-qualification': { file: 'MotePrivateChat.tsx', before: 'values: original.values, refreshCreator: true', after: 'values: original.values' },
  'refresh-blocks-policy-save': { file: 'MotePrivateChat.tsx', before: "const pending = currentIntents.some(intent => intent.method === 'space.mote.chat.configure' && !intent.input.refreshCreator)", after: "const pending = currentIntents.some(intent => intent.method === 'space.mote.chat.configure')" },
  'refresh-overwrites-guest-draft': { file: 'MotePrivateChat.tsx', before: "setIdentityFeedback({ kind: 'confirmed', message: 'Main identity confirmed for ' + original.values.connection!.application.appId + '. Guest settings drafts are kept.' })", after: "useValues(operation.configuration.values); setIdentityFeedback({ kind: 'confirmed', message: 'Main identity confirmed for ' + original.values.connection!.application.appId + '. Guest settings drafts are kept.' })" },
  'refresh-restores-as-policy-draft': { file: 'MotePrivateChat.tsx', before: "const requestDrafts = Object.values(useAppStore.getState().moteChatIntents).filter(intent => intent.method === 'space.mote.chat.configure' && !intent.input.refreshCreator &&", after: "const requestDrafts = Object.values(useAppStore.getState().moteChatIntents).filter(intent => intent.method === 'space.mote.chat.configure' &&" },
  'refresh-adopts-new-revision': { file: 'MotePrivateChat.tsx', before: "} catch (error) {\n      if (mounted.current && hostingKey(currentHosting.current) === hostingKey(owner)) setIdentityFeedback(", after: "} catch (error) {\n      const latest = await api.moteChat.call('space.mote.chat.inspect', { target }, owner)\n      if (latest.configuration) await submitMoteChatIntent({ method: 'space.mote.chat.configure', phase: 'not-dispatched', hostingTarget: owner, input: { operationId: mintObjectId(), target, expectedRevision: latest.configuration.revision, expectedConnectionRevision: savedConnection.revision, values: original.values, refreshCreator: true } })\n      if (mounted.current && hostingKey(currentHosting.current) === hostingKey(owner)) setIdentityFeedback(" }
}
if (mutation && !['fixed-interval', 'discard-unknown-input', 'allocate-wrong-total', 'verbose-profile-issue', 'drop-profile-issue-detail', ...Object.keys(connectionMutations)].includes(mutation)) throw Error('Unknown Mote chat Profile mutation')
export default defineConfig({ ...original, root, define: { ...original.define, __AGENTMUX_WEB_PREVIEW__: 'true' }, cacheDir: resolve(root, '.cache/mote-private-chat-profile'),
  plugins: [{ name: 'original-mote-chat-profile-mutations', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/components/MotePrivateChat.tsx', 'apps/desktop/src/renderer/src/components/MoteChatPeople.tsx', 'apps/desktop/src/renderer/src/components/MoteChatRequests.tsx', 'apps/desktop/src/renderer/src/lib/mote-chat-request.ts', 'apps/desktop/src/renderer/src/lib/mote-chat-draft.ts'].includes(file)) return
    let code = source, applied: string | null = null
    const anchor = mutation === 'fixed-interval' && file.endsWith('/MotePrivateChat.tsx') ? 'conversationIdleMs: idle'
      : mutation === 'discard-unknown-input' && file.endsWith('/mote-chat-request.ts') ? 'if (!dispatched ||'
        : mutation === 'allocate-wrong-total' && file.endsWith('/MoteChatPeople.tsx') ? 'expectedPersonRevision: person.revision, total: count'
          : mutation === 'verbose-profile-issue' && file.endsWith('/MoteChatPeople.tsx') ? 'profileIssueSummary="Profile update unconfirmed"'
            : mutation === 'drop-profile-issue-detail' && file.endsWith('/MoteChatPeople.tsx') ? '<p className="mote-details__hint">{profileRead.issue}</p>' : null
    if (anchor) {
      if (source.split(anchor).length !== 2) throw Error('Missing unique actual Profile consumer mutation')
      code = source.replace(anchor, mutation === 'fixed-interval' ? 'conversationIdleMs: MOTE_CHAT_DEFAULT_VALUES.conversationIdleMs'
        : mutation === 'discard-unknown-input' ? 'if (true ||'
          : mutation === 'verbose-profile-issue' ? ''
            : mutation === 'drop-profile-issue-detail' ? '<p className="mote-details__hint" />'
              : 'expectedPersonRevision: person.revision, total: person.used'); applied = mutation!
    }
    const connectionMutation = mutation && connectionMutations[mutation]
    if (connectionMutation && file.endsWith('/' + connectionMutation.file)) {
      if (source.split(connectionMutation.before).length !== 2) throw Error('Missing unique actual connector navigation mutation')
      code = source.replace(connectionMutation.before, connectionMutation.after); applied = mutation!
    }
    if (process.env.AGENTMUX_MOTE_CHAT_PROFILE_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_MOTE_CHAT_PROFILE_LOADED, JSON.stringify({ file, originalSHA256: sha(source), sha256: sha(code), mutation: applied }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }, ...(original.plugins ?? [])], test: { ...original.test, include: ['apps/desktop/test/mote-private-chat-profile.test.tsx', 'apps/desktop/test/mote-private-chat-hosting.test.tsx'], fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
