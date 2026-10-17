import { expect, it, vi } from 'vitest'
import { DiagnosticEvidenceQuery, unavailableDiagnosticEvidence } from '../src/query.js'

it('reads equal JSON targets once across root and related layers while preserving array order and original targets', async () => {
  type Target = { domain: string; key: string; scope: { owner: { kind: string; id: string }; labels: string[] } }
  const root: Target = { domain: 'ordinary-source', key: 'root', scope: { owner: { kind: 'retained', id: 'owner' }, labels: ['first', 'second'] } }
  const branch: Target = { ...root, key: 'branch' }, leaf: Target = { ...root, key: 'leaf' }
  const reordered = (target: Target): Target => ({ scope: { labels: [...target.scope.labels],
    owner: { id: target.scope.owner.id, kind: target.scope.owner.kind } }, key: target.key, domain: target.domain })
  const reorderedRoot = reordered(root), reorderedLeaf = reordered(leaf)
  const reversed: Target = { ...leaf, scope: { ...leaf.scope, labels: [...leaf.scope.labels].reverse() } }
  const references = [reorderedRoot, branch, leaf, reorderedLeaf, reversed], originalReferences = JSON.stringify(references)
  const read = vi.fn(async (target: Target) => ({ ...unavailableDiagnosticEvidence<Target, string>(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'),
    availability: 'found' as const, data: target.key, completeness: 'complete' as const, issue: null }))
  const result = await new DiagnosticEvidenceQuery().inspect(root, { read }, {
    related: read => read.target.key === 'root' ? references : read.target.key === 'branch' ? [reorderedLeaf] : [],
  })
  expect(read).toHaveBeenCalledTimes(4)
  expect(result.reads.map(read => read.target)).toEqual([root, branch, leaf, reversed])
  expect(result.reads[0]?.target).toBe(root); expect(result.reads[2]?.target).toBe(leaf)
  expect(result.budget.usedReads).toBe(4); expect(result.completeness).toBe('complete')
  expect(JSON.stringify(references)).toBe(originalReferences)
})
