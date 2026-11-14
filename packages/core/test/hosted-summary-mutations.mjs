export const hostedSummaryMutations = {
  'historical-ledger-restored': {
    kind: 'continuity', file: 'packages/core/src/hosted-session-summary.ts',
    before: 'const { continuityOperations: _history, ...source } = session',
    after: 'const source = session',
    target: 'shrinks historical continuity ledgers in actual bootstrap while retaining current continuity'
  },
  'cached-recovery-operation': {
    kind: 'recovery', file: 'apps/mobile/src/conversation/mobile-agent-recovery.ts',
    before: 'const operation = result.session.continuityOperations?.[intent.input.operationId]',
    after: 'const operation = client.agentSession(agentSessionId).continuityOperations?.[intent.input.operationId]',
    target: 'settles the exact pending recovery from public agent.inspect while the real summary cache omits historical operations'
  },
  'initial-session-feedback': {
    kind: 'cost', file: 'packages/core/src/hosted-client.ts',
    before: "for (const retained of bootstrap.sessions) publisher.publish({ type: 'agent-session', session: structuredClone(retained) })",
    after: "for (const retained of bootstrap.sessions) emit({ type: 'agent-session', session: structuredClone(retained) })",
    target: 'initial bootstrap costs stay linear for actual 200 and 2000 summary consumers'
  },
  'full-session-projection': {
    kind: 'core', file: 'packages/core/src/hosted-runtime-service.ts',
    before: "sessions: projection === 'summary' ? sessions.map(hostedAgentSessionSummary) : sessions,",
    after: 'sessions,', target: 'shrinks the encoded bootstrap of 2000 distinct 50KB prompts'
  },
  'cached-prompt-body': {
    kind: 'mobile', file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts',
    before: 'const full = await originalClient.readAgentSession(originalId)',
    after: 'const full = originalSession', target: 're-reads the matching summary at the exact Session'
  },
  'startup-full-projection': {
    kind: 'core', file: 'packages/core/src/hosted-client.ts',
    before: "method: sessionProjection === 'summary' ? 'listRuns' : 'runtimeProjection'",
    after: "method: 'runtimeProjection'", target: 'keeps full consumers full and summary caches small'
  },
  'receipt-full-compare': {
    kind: 'core', file: 'packages/core/src/hosted-client.ts',
    before: '!dequal(previous, projected)', after: '!dequal(previous, updated)',
    target: 'keeps full consumers full and summary caches small'
  }
}
export const hostedSummaryTests = {
  continuity: 'packages/core/test/hosted-continuity-summary.test.ts',
  recovery: 'apps/mobile/test/mobile-agent-recovery.test.tsx',
  cost: 'packages/core/test/hosted-bootstrap-cost.test.ts',
  core: 'packages/core/test/hosted-bootstrap-size.test.ts',
  mobile: 'apps/mobile/test/mobile-original-retry.test.tsx'
}
