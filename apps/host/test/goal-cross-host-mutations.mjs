export const crossHostMutations = {
  signature: {
    path: 'packages/core/src/agent-creation-authority.ts',
    anchor: "if (bytes.toString('base64url') !== signature || !verify(null, Buffer.from(JSON.stringify(payload)), publicKey(trust.publicKey).key, bytes)) failure('The original message source signature is invalid.', 'AGENT_MESSAGE_AUTHORITY_INVALID')",
    replacement: "if (false) failure('The original message source signature is invalid.', 'AGENT_MESSAGE_AUTHORITY_INVALID')",
    test: 'requires message-purpose'
  },
  'remote-report-owner': {
    path: 'apps/host/src/goal-delegation-owner.ts',
    anchor: "if (method === 'goal.report' && (input as GoalDelegationParamsMap['goal.report']).sourceMessageId !== undefined)",
    replacement: 'if (false)',
    test: 'takes a remote worker'
  },
  'signed-pull': {
    path: 'apps/host/src/goal-delegation-owner.ts',
    anchor: 'if (delegationWorkerHostId(saved) !== saved.hostId) {',
    replacement: 'if (false) {',
    test: 'takes a remote worker'
  },
  'plan-dependency': {
    path: 'packages/demand/src/goal-plan.ts',
    anchor: "else state = node.dependsOn.every(dependency => stateOf(byId.get(dependency)!) === 'done') ? 'ready' : 'waiting'",
    replacement: "else state = 'ready'",
    test: 'takes a remote worker'
  },
  'worker-handoff-guidance': {
    path: 'packages/core/src/agentmux.ts',
    anchor: "method === 'goal.report' ? goalReportGuidance(result as GoalReportResult, invocation.params as GoalDelegationParamsMap['goal.report'])",
    replacement: "method === 'goal.report' ? undefined",
    test: 'retains the original report through current Supervisor collection'
  }
}
