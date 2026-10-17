import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
const target = 'apps/desktop/src/renderer/src/lib/agent-menu-target.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
await verifyRendererSourceMutations({
  name: 'focus-agent-targets',
  evidenceRoot: resolve('.bagakit/feature-tracker/features/f-34b8fktjy/artifacts'),
  owningConfig: 'apps/desktop/test/vitest.context-hover.config.mts',
  tests: ['apps/desktop/test/focus-stop-agent.test.tsx', 'apps/desktop/test/session-restart.test.tsx'],
  sources: [target, store, ...['FocusStopAgent', 'SessionRestart', 'FocusContextMenu', 'FocusToolbar', 'RegionContextMenu', 'WorkspaceWorkbench'].map(component),
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs'],
  mutations: [
    { label: 'original-presentation-and-control-must-select-target', file: target,
      before: 'session.id === target.id && session.hostId === target.hostId &&\n    session.control.hostId === control.hostId && session.control.agentSessionId === control.agentSessionId',
      after: 'session.id === target.id' },
    { label: 'stop-must-recheck-original-run-at-confirmation', file: component('FocusStopAgent'),
      before: 'if (!agentMenuRunMatches(current, control))', after: 'if (false)' },
    { label: 'restart-must-recheck-original-run-at-confirmation', file: component('SessionRestart'),
      before: 'if (!original.submitted && !agentMenuRunMatches(current, control))', after: 'if (false)' },
    { label: 'single-copy-must-use-canonical-agent-id', file: component('FocusContextMenu'),
      before: 'sessionId: context.control.agentSessionId', after: 'sessionId: context.id' },
    { label: 'region-must-select-original-execution-host', file: component('RegionContextMenu'),
      before: 'session.control.agentSessionId === agentSessionId && session.hostId === execution.hostId && session.control.hostId === execution.hostId',
      after: 'session.control.agentSessionId === agentSessionId' },
    { label: 'restart-receipt-must-update-exact-canonical-host-presentations', file: store,
      before: 'current.control.hostId === control.hostId && current.control.agentSessionId === control.agentSessionId &&\n          (current.control.run.runId === control.run.runId || current.control.run.runId === session.control.run.runId)',
      after: 'current.id === session.id' }
  ]
})
