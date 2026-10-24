const core = ['packages/core/test/a2a-message-metadata.test.ts']
const shared = ['packages/client-ui/test/a2a-message-metadata.test.tsx']
const consumers = ['apps/desktop/test/a2a-primary-reading-consumers.test.tsx']
const bridge = ['apps/desktop/test/a2a-message-data-bridge.test.tsx']
export const messageMetadataMutations = [
  { name: 'journal-borrows-later-notice', path: 'packages/core/src/agent-global-message-queue.ts', tests: core,
    before: 'const selectedId = notificationId ?? this.db.prepare(', after: 'const selectedId = this.db.prepare(' },
  { name: 'journal-drops-result-clock', path: 'packages/core/src/agent-global-message-queue.ts', tests: core,
    before: 'preparedAt: notice.preparedAt ?? null, resultRecordedAt: notice.resultRecordedAt ?? null,',
    after: 'preparedAt: notice.preparedAt ?? null, resultRecordedAt: null,' },
  { name: 'rpc-drops-exact-notice', path: 'packages/core/src/public-rpc-service.ts', tests: core,
    before: "...(p.notificationId === undefined ? {} : { notificationId: rpcString(p.notificationId, 'Original notification ID') }) }",
    after: '...{} }' },
  { name: 'codec-accepts-another-notice', path: 'packages/core/src/rpc-native-codec.ts', tests: core,
    before: 'if (selected.notificationId !== notificationId) fail()', after: 'if (false) fail()' },
  { name: 'card-borrows-later-notice', path: 'packages/client-ui/src/components/ConversationA2AMetadata.tsx', tests: shared,
    before: 'notificationId && notice?.notificationId === notificationId && notice.state',
    after: 'notificationId && notice?.notificationId && notice.state' },
  { name: 'card-invents-historical-confirmation', path: 'packages/client-ui/src/components/ConversationA2AMetadata.tsx', tests: shared,
    before: "const notice = originalNotice(props), sentAt = props.message.envelope.createdAt\n  const confirmedAt = notice?.state === 'submitted' ? notice.resultRecordedAt : undefined",
    after: "const notice = originalNotice(props), sentAt = props.message.envelope.createdAt\n  const confirmedAt = notice?.state === 'submitted' ? notice.resultRecordedAt ?? sentAt : undefined" },
  { name: 'card-labels-steer-as-idle', path: 'packages/client-ui/src/components/ConversationA2AMetadata.tsx', tests: shared,
    before: "notice?.mode === 'steer' ? '立即通知'", after: "notice?.mode === 'steer' ? '空闲后通知'" },
  { name: 'desktop-drops-exact-notice', path: 'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', tests: consumers,
    before: 'await api.sessions.readMessage(reference, messageId, notificationId)', after: 'await api.sessions.readMessage(reference, messageId)' },
  { name: 'mobile-drops-exact-notice', path: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', tests: consumers,
    before: 'return client.readMessage({ messageId, ...(notificationId === undefined ? {} : { notificationId }) })', after: 'return client.readMessage({ messageId })' },
  { name: 'preload-drops-exact-notice', path: 'apps/desktop/src/preload/index.ts', tests: bridge,
    before: "ipcRenderer.invoke('sessions:message', session, messageId, notificationId)", after: "ipcRenderer.invoke('sessions:message', session, messageId)" },
  { name: 'cached-unknown-never-reconciles', path: 'packages/client-ui/src/components/ConversationA2AReferences.tsx', tests: shared,
    before: 'current?.message && current.attempt === attempt', after: 'current?.message' }
]

export function transformMessageMetadata(source, path, name) {
  if (!name) return source
  const edit = messageMetadataMutations.find(item => item.name === name)
  if (!edit) throw Error('Unknown message metadata mutation: ' + name)
  if (path !== edit.path) return source
  if (source.split(edit.before).length !== 2) throw Error('Mutation must match exactly one production behavior: ' + name)
  return source.replace(edit.before, edit.after)
}
