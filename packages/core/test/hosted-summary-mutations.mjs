export const hostedSummaryMutations = {
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
  core: 'packages/core/test/hosted-bootstrap-size.test.ts',
  mobile: 'apps/mobile/test/mobile-original-retry.test.tsx'
}
