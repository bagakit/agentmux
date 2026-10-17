import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = 'apps/desktop/src/renderer/src/components/AgentInputRecap.tsx'
await verifyRendererSourceMutations({
  name: 'agent-input-protected-cost-' + crypto.randomUUID(),
  tests: ['apps/desktop/test/agent-input-protected-cost.test.tsx', 'apps/desktop/test/agent-reading-pin.test.tsx'],
  owningConfig: 'apps/desktop/test/vitest.context-hover.config.mts',
  sources: [component, 'apps/desktop/src/renderer/src/lib/session-user-messages.ts',
    'packages/client-ui/src/lib/use-conversation-view.ts',
    'apps/desktop/test/helpers/agent-card-conversation-fixture.ts',
    'apps/desktop/test/helpers/conversation-read-bridge.ts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs'],
  mutations: [
    { label: 'protected-bookmark-must-park-after-original-batch', file: component,
      before: 'if (request.bookmark) { setPaused(true); return }',
      after: 'if (request.bookmark) return' },
    { label: 'paused-reading-must-retain-original-view', file: component,
      before: 'useSessionUserMessages(request.control,',
      after: 'useSessionUserMessages(paused ? undefined : request.control,' },
    { label: 'explicit-follow-must-resume-original-reading', file: component,
      before: 'if (follow) { setFrozen(null); setPaused(false) }',
      after: 'if (follow) { setFrozen(null) }' }
  ]
})
