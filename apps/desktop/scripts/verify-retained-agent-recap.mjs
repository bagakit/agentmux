import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = 'apps/desktop/src/renderer/src/components/AgentContextContent.tsx'
const observed = "(context.processState === 'running' || context.processState === 'exited')"
await verifyRendererSourceMutations({
  name: 'retained-agent-recap',
  owningConfig: 'apps/desktop/test/vitest.context-hover.config.mts',
  tests: ['apps/desktop/test/focus-context-recap-menu.test.tsx', 'apps/desktop/test/focus-recovery-classification.test.tsx'],
  sources: [component, 'apps/desktop/test/fixtures/focus-filter-menu.ts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs'],
  mutations: [
    { label: 'observed-exit-must-retain-original-reply', file: component,
      before: observed, after: "context.processState === 'running'" },
    { label: 'interrupted-run-must-retain-service-priority', file: component,
      before: observed, after: 'true' }
  ]
})
