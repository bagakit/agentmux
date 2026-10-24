export const resumedInboxMutations = [
  { name: 'new-notice-uses-envelope-run', file: 'client.ts',
    before: 'condition: agentPromptCondition(session), messageIds: input.messageIds,',
    after: 'condition: { ...agentPromptCondition(session), expectedRun: { runId: first.recipientRunId! } }, messageIds: input.messageIds,',
    test: '^source CLI freezes a new explicit notification' },
  { name: 'retained-notice-recaptures-run', file: 'client.ts',
    before: 'let notification: AgentMuxMessageNotification | null = retained', after: 'let notification: AgentMuxMessageNotification | null = null',
    test: '^coalesces different historical Runs' },
  { name: 'automatic-restored-sources-omitted', file: 'agent-message-notifications.ts',
    before: 'const sourceRuns = sessionSemanticResumeSourceRuns(session)', after: 'const sourceRuns = [session.run.runId]',
    test: '^automatically selects untouched historical references' },
  { name: 'unconfirmed-chain-expands-sources', file: 'agent-session-resume-sources.ts',
    before: '  return runs\n}', after: '  return [session.run.runId, ...session.retiredRuns.map(run => run.runId)]\n}',
    test: 'source Runs for missing-chain' },
  { name: 'historical-envelope-run-relocked', file: 'rpc-native-codec.ts',
    before: 'key.agentSessionId !== envelope.recipientSessionId) fail()', after: 'key.agentSessionId !== envelope.recipientSessionId || key.expectedRun.runId !== envelope.recipientRunId) fail()',
    test: '^source CLI freezes a new explicit notification' },
  { name: 'inspect-reenters-writer', file: 'client.ts',
    before: '    const record = await this.inspectAgentPromptSubmission(notification.key)',
    after: '    await this.submitMessageNotification(notification)\n    const record = await this.inspectAgentPromptSubmission(notification.key)',
    test: '^reads a pending original notice' },
  { name: 'inspect-accepts-ordinary-producer', file: 'client.ts',
    before: 'if (record && !isMessageNotificationInput(notification, record))', after: 'if (false)',
    test: '^promotes a producer-qualified input ACK' },
  { name: 'public-inspect-disconnected', file: 'public-rpc-service.ts',
    before: "owner.client.inspectMessageNotification({ operationId: rpcString(p.operationId, 'Notification operation ID') })",
    after: 'Promise.resolve({ notification: null, input: null })',
    test: '^source CLI freezes a new explicit notification' },
  { name: 'unknown-reference-index-ignored', file: 'agent-global-message-queue.ts', occurrences: 3,
    before: 'AND NOT EXISTS (SELECT 1 FROM a2a_unresolved_notification_references refs WHERE refs.message_id=a2a_message_notifications.message_id)', after: '',
    test: '^reopens old-version manual unknown' },
  { name: 'unresolved-original-links-not-indexed', file: 'agent-message-journal.ts',
    before: "WHERE n.result_sequence IS NULL OR json_extract(result.json, '$.state')='unconfirmed';", after: 'WHERE 0;',
    test: '^reopens old-version manual unknown' },
  { name: 'unknown-sibling-operation-dropped', file: 'agent-global-message-queue.ts',
    before: 'SELECT refs.notification_id FROM a2a_unresolved_notification_references refs', after: 'SELECT NULL FROM a2a_unresolved_notification_references refs',
    test: '^keeps a second unknown manual operation' },
  { name: 'source-cli-inspects-another-operation', file: 'agentmux-cli-commands.ts',
    before: "f => ({ hostId: id(f, '--host', true), operationId: id(f, '--operation-id', true) })",
    after: "f => ({ hostId: id(f, '--host', true), operationId: 'wrong-' + id(f, '--operation-id', true) })",
    test: '^source CLI freezes a new explicit notification' }
]

export function transformResumedInboxSource(source, path, name) {
  if (!name) return source
  const change = resumedInboxMutations.find(item => item.name === name)
  if (!change) throw new Error('Unknown resumed Inbox source mutation: ' + name)
  if (path !== 'packages/core/src/' + change.file) return source
  if (source.split(change.before).length - 1 !== (change.occurrences ?? 1)) throw new Error('Resumed Inbox mutation anchor changed: ' + name)
  return source.replaceAll(change.before, change.after)
}
