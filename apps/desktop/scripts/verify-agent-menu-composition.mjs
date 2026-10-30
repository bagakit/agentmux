import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
await verifyRendererSourceMutations({
  name: 'unified-agent-menu-composition',
  owningConfig: 'apps/desktop/test/vitest.agent-menu-composition.config.mts',
  tests: ['apps/desktop/test/agent-menu-product.test.tsx', 'apps/desktop/test/focus-stop-agent.test.tsx'],
  sources: ['vitest.config.ts', 'vitest.dist-freshness.ts', 'test/fixture-values.mjs', 'apps/desktop/test/vitest.mote-context.config.mts',
    ...['AgentMenuContent', 'AgentRegionHeader', 'FocusContextMenu', 'AgentNativeSourceControls', 'RegionContextMenu', 'SessionStop', 'SessionRestart'].map(component),
    'apps/desktop/src/renderer/src/components/WorkbenchMenuScope.ts',
    'apps/desktop/src/renderer/src/styles/agent-region-header.css', 'apps/desktop/src/renderer/src/styles/focus.css'],
  mutations: [
    { label: 'shared-session-details-disconnected', file: component('AgentMenuContent'),
      before: "label={sessionKind === 'agent' ? 'Session details' : 'Terminal details'}", after: "label={'Missing details'}" },
    { label: 'focus-copy-must-use-canonical-agent', file: component('FocusContextMenu'),
      before: 'sessionId: context.control.agentSessionId', after: 'sessionId: context.id' },
    { label: 'region-workspace-extension-disconnected', file: component('AgentMenuContent'),
      before: '<Menu.Group aria-label="Workspace">{extensions.workspace}</Menu.Group>',
      after: '<Menu.Group aria-label="Workspace">{null}</Menu.Group>' },
    { label: 'native-source-confirmation-must-use-canonical-identity', file: component('AgentNativeSourceControls'),
      before: 'return { agentSessionId: session.control.agentSessionId, expectedRun:', after: 'return { agentSessionId: session.id, expectedRun:' },
    { label: 'dismissal-must-not-swallow-original-confirmation-failure', file: component('AgentNativeSourceControls'),
      before: "useAppStore.getState().reportError(cause, { kind: 'indeterminate', subject: { ...session.control, run: review.expectedRun },",
      after: "if (owner.current === 'never-report') useAppStore.getState().reportError(cause, { kind: 'indeterminate', subject: { ...session.control, run: review.expectedRun }," },
    { label: 'closed-cards-must-not-subscribe-to-global-updates', file: component('FocusContextMenu'),
      before: 'open ? useAppStore.subscribe(listener) : () => {}', after: 'true ? useAppStore.subscribe(listener) : () => {}' }
  ]
})
