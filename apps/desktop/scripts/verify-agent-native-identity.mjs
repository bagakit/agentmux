import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
assert.equal(process.argv[2], '--evidence')
assert.ok(process.argv[3])
const owner = 'apps/desktop/src/renderer/src/components/AgentMenuIdentityActions.tsx'
await verifyRendererSourceMutations({ name: 'agent-native-identity', evidenceRoot: resolve(process.argv[3]),
  owningConfig: 'apps/desktop/test/vitest.agent-native-identity.config.mts',
  tests: ['apps/desktop/test/agent-native-identity.test.tsx'],
  sources: ['vitest.config.ts', 'vitest.dist-freshness.ts', 'test/fixture-values.mjs', 'apps/desktop/test/vitest.mote-context.config.mts',
    owner, 'apps/desktop/src/renderer/src/components/AgentAvatar.tsx',
    'apps/desktop/src/renderer/src/components/AgentRegionHeader.tsx',
    'apps/desktop/src/renderer/src/components/AgentMenuContent.tsx',
    'apps/desktop/src/renderer/src/components/WorkbenchActionRows.tsx',
    'apps/desktop/src/renderer/src/components/WorkbenchCopyLinkRow.tsx'],
  mutations: [
    { label: 'copy-adopted-not-observed-native-id', file: owner,
      before: 'const native = session?.nativeHandle', after: 'const native = session?.observedNativeHandle' },
    { label: 'copy-native-not-presentation-id', file: owner,
      before: 'copyTextToClipboard(native.sessionId,', after: 'copyTextToClipboard(session.id,' },
    { label: 'reject-wrong-provider-copy-only', file: owner,
      before: "(native.kind === 'provider' && providerId && native.providerId !== providerId)", after: 'false' },
    { label: 'late-clipboard-failure-keeps-original-subject', file: owner,
      before: 'error => useAppStore.getState().reportError(error, {', after: 'error => false && useAppStore.getState().reportError(error, {' },
    { label: 'preserve-configured-executor-artwork', file: owner,
      before: 'appearance={appearance}', after: 'appearance={undefined}' }
  ]
})
