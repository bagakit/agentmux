import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const main = 'apps/desktop/src/main/browser-view-manager.ts'
const store = 'apps/desktop/src/main/browser-step-evidence.ts'
const component = 'apps/desktop/src/renderer/src/components/BrowserStepEvidence.tsx'
await verifyRendererSourceMutations({
  name: 'browser-step-evidence-mutations',
  tests: ['apps/desktop/test/browser-step-evidence.test.tsx', 'apps/desktop/test/browser-run-script-wiring.test.ts', 'apps/desktop/test/browser-operation-journal.test.ts'],
  sources: [main, store, component, 'apps/desktop/src/main/browser-operation-journal.ts', 'apps/desktop/src/shared/browser-step-evidence.ts'],
  mutations: [
    { label: 'first-use-falsely-damaged', file: 'apps/desktop/src/main/browser-operation-journal.ts',
      before: "if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument()", after: "if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null" },
    { label: 'journal-evidence-disconnected', file: main, before: 'step.evidence = [...(step.evidence ?? []), reference]', after: 'step.evidence = []' },
    { label: 'foreign-step-identity-accepted', file: store, before: '!sameIdentity(value.reference, reference)', after: 'false' },
    { label: 'late-selection-overwrites-evidence', file: component, before: 'return () => { current = false }', after: 'return () => { current = true }' },
    { label: 'storage-failure-rejects-completed-action', file: main,
      before: "step.evidenceWarning = 'Step evidence could not be saved. The action result is retained; inspect the page and check local storage before recording again.'",
      after: "throw new Error('Evidence storage failed')" }
  ]
})
