import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/browser-outcome-criteria.ts'
const shared = 'apps/desktop/src/shared/browser-outcome-criteria.ts'
const ui = 'apps/desktop/src/renderer/src/components/BrowserOutcomeCriteria.tsx'
await verifyRendererSourceMutations({
  name: 'browser-outcome-criteria-mutations',
  tests: ['apps/desktop/test/browser-outcome-criteria.test.tsx'],
  sources: [file, shared, ui, 'apps/desktop/src/main/browser-structured-output.ts', 'apps/desktop/src/shared/browser-structured-output.ts',
    'apps/desktop/src/main/browser-operation-journal.ts', 'apps/desktop/src/main/browser-step-evidence.ts', 'apps/desktop/src/main/browser-result-artifact.ts'],
  mutations: [
    { label: 'historical-producer-reused', file, before: 'condition.producer.operationId !== registration.context.operationId', after: 'false' },
    { label: 'registration-navigation-join-removed', file, before: 'condition.producer.navigationId !== registration.context.navigationId', after: 'false' },
    { label: 'asset-version-ignored', file, before: 'a.version === b.version', after: 'true' },
    { label: 'script-exit-instead-of-extraction-provenance', file, before: "step?.method !== 'extractStructured'", after: 'false' },
    { label: 'preview-instead-of-complete-value', file,
      before: "if (observed?.status === 'observed') return result(condition, observed.value === condition.expected ? 'passed' : 'not-met',",
      after: "if (observed?.status === 'observed') return result(condition, receipt.fields.find(field => field.key === condition.key)?.value === condition.expected ? 'passed' : 'not-met'," },
    { label: 'source-document-join-removed', file, before: '!sameSource(document.source, receipt.source)', after: 'false' },
    { label: 'requested-schema-join-removed', file, before: 'JSON.stringify(document.request) !== JSON.stringify(requested)', after: 'false' },
    { label: 'same-channel-child-navigation-ignored', file, before: '!(await host.isStructuredSourceCurrent(document.source))', after: 'false' },
    { label: 'foreign-continuation-reference-accepted', file, before: '!sameArtifact(chunk.reference, artifact)', after: 'false' },
    { label: 'continuation-offset-ignored', file, before: 'chunk.nextOffset !== (end < artifact.byteLength ? end : null)', after: 'false' },
    { label: 'whole-json-budget-disconnected', file, before: 'artifact.byteLength > BROWSER_OUTCOME_LIMITS.documentBytes', after: 'false' },
    { label: 'historical-file-completes-current-task', file, before: 'receipt.operationId === condition.producer.operationId', after: 'true' },
    { label: 'agent-confirms-human-checkpoint', file, before: "fact.origin !== 'trusted-ui'", after: 'false' },
    { label: 'unavailable-defaults-to-passed', file,
      before: "conditions.push(result(condition, 'unavailable', 'Verification could not confirm this execution and its recorded source.",
      after: "conditions.push(result(condition, 'passed', 'Verification could not confirm this execution and its recorded source." },
    { label: 'all-condition-producers-return-empty-block', file, before: 'for (const condition of registration.criteria)', after: 'for (const condition of registration.criteria.slice(0, 0))' },
    { label: 'unsupported-empty-declaration-defaults-to-passed', file,
      before: "catch { return { ...base, status: 'unavailable', conditions: [], warning:",
      after: "catch { return { ...base, status: 'passed', conditions: [], warning:" },
    { label: 'condition-count-budget-disconnected', file: shared, before: '.max(BROWSER_OUTCOME_LIMITS.conditions)', after: '.max(80)' },
    { label: 'total-declaration-budget-disconnected', file: shared, before: '> BROWSER_OUTCOME_LIMITS.requestBytes', after: '> Infinity' },
    { label: 'ui-real-run-caller-removed', file: ui, before: 'await onRun({ request:', after: 'await Promise.resolve(); void ({ request:' }
  ]
})
