import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const pane = 'apps/desktop/src/renderer/src/components/SessionPane.tsx'
const projection = 'apps/desktop/src/renderer/src/lib/session-recovery-banner.ts'
await verifyRendererSourceMutations({
  name: 'startup-source-mutations', evidenceRoot: resolve(root, '.bagakit/agent-startup-timeout'),
  owningConfig: 'apps/desktop/test/session-startup-service-window.config.mts',
  tests: ['apps/desktop/test/session-startup-service-window.test.tsx', 'apps/desktop/test/full-page-loading-surface.test.tsx'],
  sources: [pane, projection, 'apps/desktop/src/renderer/src/components/FullPageLoadingSurface.tsx',
    'apps/desktop/src/renderer/src/styles/full-page-loading.css',
    'apps/desktop/test/vitest.mote-context.config.mts', 'vitest.config.ts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label: 'unknown-is-failure', file: projection,
      before: "if (initialization.phase === 'failed') return", after: "if (initialization.phase === 'failed' || initialization.phase === 'unknown') return" },
    { label: 'wrong-run-is-current', file: projection,
      before: 'if (!frontend || frontend.run.runId !== session.control.run.runId) return null', after: 'if (!frontend) return null' },
    { label: 'setup-step-lost', file: projection,
      before: "preflight: 'A required setup check did not complete.'", after: "preflight: 'Something happened.'" },
    { label: 'original-action-disconnected', file: pane,
      before: 'await recoverSession(sessionId, frontendRecoveryIntent.current.operationId)', after: 'await recoverSession(sessionId)' },
    { label: 'original-diagnostic-lost', file: pane,
      before: 'supplement={<>{frontendDiagnostic}{identityNotice}', after: 'supplement={<>{identityNotice}' },
    { label: 'hidden-pane-keeps-waiting', file: pane,
      before: 'visible={visible && !parked && !historyOpen}\n                title=', after: 'visible={true}\n                title=' },
    { label: 'hidden-primary-stops-visible-presentation', file: pane,
      before: 'visible: target.visible !== false && !parked, supplement: null', after: 'visible: visible && !parked, supplement: null' }
  ]
})
