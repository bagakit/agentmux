import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { provePerformanceOwner } from './performance-owner-proof.mjs'

const owner = 'apps/desktop/src/renderer/src/lib/surface-memory-budget-coordinator.tsx'
const test = 'apps/desktop/test/surface-memory-bookkeeping.test.tsx'
const proof = provePerformanceOwner({
  name: 'surface-memory-bookkeeping',
  owners: [owner,
    'apps/desktop/src/renderer/src/lib/surface-memory-budget.ts',
    'apps/desktop/src/renderer/src/lib/surface-memory-budget-candidates.ts',
    'apps/desktop/src/renderer/src/components/RendererResourceOwners.tsx',
    'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'],
  tests: [test, 'apps/desktop/test/surface-memory-budget.test.ts',
    'apps/desktop/test/surface-memory-budget-coordinator.test.ts'],
  minimumTests: 13,
  mutantTests: [test],
  mutants: [
    ['only-hidden-records-retired', owner, 'if (!currentIds.has(id)) {',
      'if (!currentIds.has(id) && regionsRef.current.get(id)?.hiddenSinceMs !== null) {'],
    ['record-retirement-omitted', owner, 'regionsRef.current.delete(id)', 'void id'],
    ['current-record-retired', owner, 'if (!currentIds.has(id)) {', 'if (currentIds.has(id)) {']
  ],
  callers: [
    ['apps/desktop/src/renderer/src/components/RendererResourceOwners.tsx', 'useSurfaceMemoryBudget({'],
    ['apps/desktop/src/renderer/src/components/RendererResourceOwners.tsx', '<SurfaceMemoryBudgetProvider state={state}>'],
    ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'useMonacoSurfaceReleased(surface.regionId)'],
    ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'useBrowserSurfaceReleased(surface.regionId)']
  ]
})

try {
  for (const run of proof.receipt.runs) {
    const raw = JSON.parse(readFileSync(join(proof.directory, run.name + '.json'), 'utf8'))
    const assertions = raw.testResults.flatMap(suite => suite.assertionResults)
    const expected = run.name === 'normal' ? 13 : 5
    assert.equal(raw.numTotalTests, expected, 'complete fixed consumer collection required')
    assert.equal(assertions.length, expected)
    assert.ok(assertions.every(test => test.status === 'passed' || test.status === 'failed'),
      'todo, skipped, pending or unknown assertions cannot qualify')
  }
  proof.receipt.boundary = 'Actual mounted RendererResourceOwners, original hook/Provider and WorkspaceWorkbench consumers; Browser/File native leaves controlled. No user Run, installed Renderer, RSS improvement or original stall claim.'
} catch (error) {
  proof.receipt.passed = false
  throw error
} finally {
  writeFileSync(join(proof.directory, 'receipt.json'), JSON.stringify(proof.receipt, null, 2) + '\n')
}
