import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

// Source-only scenario oracle proof. This script never starts the canonical GUI.
const file = 'apps/desktop/scripts/browser-outcome-probe-scenario.mjs'
await verifyRendererSourceMutations({
  name: 'browser-outcome-probe-scenario-source-mutations',
  tests: ['apps/desktop/test/browser-outcome-probe-scenario.test.ts'],
  sources: [file, 'apps/desktop/scripts/browser-demonstration-probe-scenario.mjs',
    'apps/desktop/scripts/browser-demonstration-probe-diagnostics.mjs',
    'apps/desktop/scripts/verify-browser-outcome-probe-scenario-mutations.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/src/main/browser-completion-control.ts', 'packages/core/src/control.ts',
    'packages/core/src/control-host.ts', 'packages/core/src/browser-completion-facts.ts',
    'packages/core/dist/index.js', 'packages/core/dist/browser-completion-facts.js'],
  mutations: [
    { label: 'pending-native-select-never-committed', file,
      before: "  if (before !== 'number') await key(ctx, 'Enter', 'Enter', 13)\n", after: '' },
    { label: 'empty-producer-steps-accepted', file,
      before: "  assert.deepEqual(value.steps.map(step => [step.sequence, step.method, step.status]), [[1, 'extractStructured', 'completed']])\n", after: '' },
    { label: 'foreign-registered-producer-accepted', file,
      before: "  assert.deepEqual(registered.criteria, [{ ...criterion, producer: { operationId: value.id,\n    navigationId: registered.context.navigationId, sequence: 1, request: { fields: [field] } } }])\n", after: '' },
    { label: 'public-completion-dropped-silently', file,
      before: "  assert.deepEqual(value.completion, actual.outcome.evaluation, 'Core public completion must match the actual Main result')\n", after: '' },
    { label: 'public-operation-identity-ignored', file, before: 'assert.equal(value.id, actual.id); ', after: '' },
    { label: 'raw-main-provenance-exposed-publicly', file,
      before: "  assert.equal(Object.hasOwn(value, 'outcome'), false, 'Producer declarations stay in the Main DTO')\n", after: '' },
    { label: 'public-history-success-result-layer-removed', file,
      before: 'const operations = listed.result.operations', after: 'const operations = listed.operations' },
    { label: 'public-operation-success-result-layer-removed', file,
      before: 'auditPublicCompletion(read.result.runOperation, actual)', after: 'auditPublicCompletion(read.runOperation, actual)' },
    { label: 'original-evidence-reference-join-removed', file,
      before: '  assert.deepEqual(actual.steps[0].evidence.find(reference => reference.id === item.reference.id), item.reference)\n', after: '' },
    { label: 'foreign-artifact-chunk-accepted', file, before: 'assert.deepEqual(chunk.reference, artifact); ', after: '' },
    { label: 'complete-json-source-join-removed', file, before: 'assert.deepEqual(document.source, receipt.source); ', after: '' },
    { label: 'complete-json-value-ignored', file,
      before: "  assert.deepEqual(document.fields.map(value => [value.key, value.status, value.value]), [['result', 'observed', 0]])\n", after: '' },
    { label: 'raw-json-request-join-removed', file, before: 'assert.deepEqual(document.request, { fields: [field] })', after: 'void document.request' },
    { label: 'readonly-read-starts-another-producer', file,
      before: "  assert.deepEqual(await ids(ctx), before, 'Reading the saved bytes cannot start another producer')\n", after: '' }
  ]
})
