import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/scripts/browser-outcome-probe-scenario.mjs'
await verifyRendererSourceMutations({
  name: `browser-outcome-minimum-module-mutations-${Date.now()}`,
  tests: ['apps/desktop/test/browser-outcome-minimum-radio.test.tsx'],
  sources: [file, 'apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx',
    'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs',
    'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs',
    'apps/desktop/scripts/verify-browser-recovery-restart.mjs'],
  mutations: [{ label: 'complete-minimum-observer-path-import-removed', file,
    before: "import { join } from 'node:path'\n", after: '' }]
})
