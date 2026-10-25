// Each substitution changes a real product boundary; tests remain unchanged.
export const collaborationMutations = [
  { scope: 'discovery-hosted', name: 'namespace-without-bootstrap', file: 'packages/core/src/agent-discovery.ts',
    before: 'const namespaces = await Promise.allSettled(scopes.map(async scope => await scope.client.readAgentMessageQueuePath()))',
    after: "const namespaces = scopes.map(scope => ({ status: 'fulfilled' as const, value: scope.client.agentMessageQueuePath() }))" },
  { scope: 'discovery-hosted', name: 'namespace-binds-cursor', file: 'packages/core/src/agent-discovery.ts',
    before: "return [scope.hostId, namespace.status === 'fulfilled' ? namespace.value : null]", after: 'return [scope.hostId]' },
  { scope: 'discovery', name: 'candidate-budget', file: 'packages/core/src/agent-discovery.ts',
    before: 'await Promise.all(selected.map(async candidate => {',
    after: 'await Promise.all(relevant.filter(candidate => candidate.session).map(candidate => candidate.scope.client.statusAgent(candidate.session!.agentSessionId)))\n  await Promise.all(selected.map(async candidate => {' },
  { scope: 'discovery', name: 'metadata-before-probe', file: 'packages/core/src/agent-discovery.ts',
    before: 'filters.executorId && session.executorId !== filters.executorId', after: 'false' },
  { scope: 'discovery', name: 'original-activity-clock', file: 'packages/core/src/agent-discovery.ts',
    before: 'observedAt: activity.observedAt, run:', after: 'observedAt: session.updatedAt, run:' },
  { scope: 'broadcast', name: 'claimed-target-is-not-replayed', file: 'packages/core/src/agent-global-message-queue.ts',
    before: 'if (row.claim_sequence !== null) return false', after: 'if (row.claim_sequence !== null) return true' },
  { scope: 'broadcast', name: 'event-window-has-an-end', file: 'packages/core/src/agent-global-message-queue.ts',
    before: 'nextAfterSequence: !backward && rows.length > limit ? events.at(-1)!.sequence : null',
    after: 'nextAfterSequence: !backward && rows.length >= limit ? events.at(-1)!.sequence : null' },
  { scope: 'broadcast', name: 'event-reference-keeps-participant', file: 'packages/core/src/agent-message-events.ts',
    before: 'ref.senderSessionId !== input.participantSessionId && ref.recipientSessionId !== input.participantSessionId', after: 'false' },
  { scope: 'spawn', name: 'prepared-creation-retains-creator', file: 'packages/core/src/client.ts',
    before: 'creation: { createOperationId, intentDigest, ...(createdBy ? { createdBy } : {}),',
    after: 'creation: { createOperationId, intentDigest,' },
  { scope: 'spawn', name: 'child-context-discloses-original-creator', file: 'packages/core/src/client.ts',
    before: 'createdBy ? agentSpawnContext(createdBy) : undefined', after: 'undefined' },
  { scope: 'spawn', name: 'receipt-retains-birth-run', file: 'packages/core/src/client.ts',
    before: "const creation: NonNullable<AgentMuxAgentSession['creation']> = {\n        createOperationId,\n        intentDigest,\n        ...(createdBy ? { createdBy, createdRun: runRef(run.runId) } : {}),",
    after: "const creation: NonNullable<AgentMuxAgentSession['creation']> = {\n        createOperationId,\n        intentDigest,\n        ...(createdBy ? { createdBy } : {})," },
  { scope: 'spawn', name: 'no-prompt-product-creation-retains-caller', file: 'apps/desktop/src/renderer/src/lib/space-agent-control.ts',
    before: "...(request.caller ? { creationCaller: { agentSessionId: request.caller.agentSessionId, capability: request.caller.capability ?? '' } } : {}),",
    after: '...{},' },
  { scope: 'spawn', name: 'remote-creation-uses-original-owner', file: 'packages/core/src/agent-spawn-query.ts',
    before: "parameters.push(query.creatorRuntimeId ? 'runtime' : 'local', query.creatorRuntimeId ?? '')",
    after: "parameters.push('local', '')" }
]

export const collaborationTests = {
  'discovery-hosted': 'packages/core/test/agent-discovery-hosted.test.ts',
  discovery: 'packages/core/test/a2a-agent-discovery.test.ts',
  broadcast: 'packages/core/test/a2a-broadcast-events.test.ts',
  spawn: ['packages/core/test/a2a-spawn.test.ts', 'packages/core/test/a2a-spawn-product.test.ts']
}
