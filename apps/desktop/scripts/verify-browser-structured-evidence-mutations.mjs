import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const file = 'apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx'
await verifyRendererSourceMutations({ name: `browser-structured-evidence-mutations-${Date.now()}`,
  tests: ['apps/desktop/test/browser-step-evidence.test.tsx'],
  sources: [file, 'apps/desktop/src/renderer/src/components/BrowserStructuredFields.tsx'],
  mutations: [
    { label: 'recorded-fields-not-mounted', file,
      before: "item.content.kind === 'structured-output' ? <BrowserStructuredFields",
      after: "item.content.kind === 'structured-output' && false ? <BrowserStructuredFields" },
    { label: 'raw-result-reads-a-different-step', file,
      before: 'api.browser.readStepResult(operation.id, step.sequence, options)',
      after: 'api.browser.readStepResult(operation.id, step.sequence + 1, options)' }
  ]
})
