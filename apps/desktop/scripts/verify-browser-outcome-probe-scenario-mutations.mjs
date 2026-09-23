import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

// Source-only scenario oracle proof. This script never starts the canonical GUI.
const file = 'apps/desktop/scripts/browser-outcome-probe-scenario.mjs'
await verifyRendererSourceMutations({
  name: 'browser-outcome-probe-scenario-source-mutations',
  tests: ['apps/desktop/test/browser-outcome-probe-scenario.test.ts'],
  sources: [file, 'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs',
    'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs'],
  mutations: [
    { label: 'empty-producer-steps-accepted', file,
      before: "  assert.deepEqual(value.steps.map(step => [step.sequence, step.method, step.status]), [[1, 'extractStructured', 'completed']])\n", after: '' },
    { label: 'foreign-registered-producer-accepted', file,
      before: "  assert.deepEqual(registered.criteria, [{ ...criterion, producer: { operationId: value.id,\n    navigationId: registered.context.navigationId, sequence: 1, request: { fields: [field] } } }])\n", after: '' },
    { label: 'public-completion-dropped-silently', file,
      before: "  assert.deepEqual(value.completion, actual.outcome.evaluation, 'Core public completion must match the actual Main result')\n", after: '' },
    { label: 'public-operation-identity-ignored', file, before: 'assert.equal(value.id, actual.id); ', after: '' },
    { label: 'raw-main-provenance-exposed-publicly', file,
      before: "  assert.equal(Object.hasOwn(value, 'outcome'), false, 'Producer declarations stay in the Main DTO')\n", after: '' },
    { label: 'foreign-artifact-chunk-accepted', file, before: 'assert.deepEqual(chunk.reference, artifact); ', after: '' },
    { label: 'raw-json-request-join-removed', file, before: 'assert.deepEqual(document.request, { fields: [field] })', after: 'void document.request' },
    { label: 'readonly-read-starts-another-producer', file,
      before: "  assert.deepEqual(await ids(ctx), before, 'Reading the saved bytes cannot start another producer')\n", after: '' }
  ]
})
