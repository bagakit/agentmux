import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { openDemandStore } from '../src/demand-store.js'
import { parseDemandEvidence, parseGroundingProposal, isCurrentGroundingAccepted, type DemandFileEvidence } from '../src/goals.js'

const evidence: DemandFileEvidence = { kind: 'file', resource: { hostId: 'source-host', workspaceId: 'worktree', workspacePath: fixturePath('worktree'), zoneId: 'source-zone', zonePath: fixturePath('worktree/results'), path: 'results/check.log' }, revision: 'sha256:' + 'a'.repeat(64), location: { line: 3, column: 2 } }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('preserves original text and complete file provenance without inventing a source', () => {
  const original = '  results/check.log:3  '
  const proposal = parseGroundingProposal({ alignmentRevision: 1, summary: 'Result', checks: [{ criterionId: 'c', outcome: 'met', evidence: [original, evidence], note: '' }] })
  expect(proposal.checks[0]!.evidence).toEqual([original, evidence])
  expect(parseDemandEvidence({ ...evidence, revision: null })).toEqual({ ...evidence, revision: null })
})
it.each([
  { ...evidence, resource: { ...evidence.resource, path: '../other/check.log' } },
  { ...evidence, resource: { ...evidence.resource, path: 'elsewhere/check.log' } },
  { ...evidence, resource: { ...evidence.resource, hostId: '' } },
  { ...evidence, revision: 'unknown-hash' }, { ...evidence, location: { line: 0 } },
  { ...evidence, acceptedAt: 1 }
])('refuses an invalid file reference without rewriting it', value => { expect(() => parseDemandEvidence(value)).toThrow() })
it('keeps an original human acceptance independent of later proposal readiness', () => {
  const alignment = { summary: 'Original', criteria: [], openQuestions: ['Later observation'], revision: 1, confirmedAt: 1 }
  const grounding = { alignmentRevision: 1, summary: 'Reported', checks: [], submissionId: 'original', acceptedAt: 2 }
  expect(isCurrentGroundingAccepted(alignment, grounding)).toBe(true)
  expect(isCurrentGroundingAccepted({ ...alignment, revision: 2 }, grounding)).toBe(false)
  expect(isCurrentGroundingAccepted({ ...alignment, confirmedAt: null }, grounding)).toBe(false)
  expect(isCurrentGroundingAccepted(alignment, { ...grounding, acceptedAt: null })).toBe(false)
})
it('collects original resources from multiple reports, deduplicates values and restores them intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-evidence-')); roots.push(root)
  const store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Original', assigneeSessionIds: ['owner', 'a', 'b'], supervisorSessionId: 'owner' })
  await store.proposeAlignment('goal', { summary: 'Original', criteria: [{ id: 'c', text: 'Outcome' }], openQuestions: [] })
  for (const worker of ['a', 'b']) {
    const task = { operationId: 'delegate-' + worker, sourceMessageId: 'source-' + worker, hostId: 'source-host', ownerAgentSessionId: 'owner', workerAgentSessionId: worker, ownerRunId: 'owner-run', workerRunId: worker + '-run', threadId: 'thread', text: 'Original task', alignmentRevision: 1, criterionIds: ['c'] }
    await store.prepareDelegation('goal', task, 'owner'); await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
    await store.submitDelegationReport('goal', task.operationId, { operationId: 'report-' + worker, replyMessageId: 'reply-' + worker, authorAgentSessionId: worker,
      grounding: { alignmentRevision: 1, summary: 'Report', checks: [{ criterionId: 'c', outcome: worker === 'a' ? 'met' : 'gap', evidence: [structuredClone(evidence), 'Original citation'], note: worker === 'a' ? '' : 'Remaining gap' }] } }, worker)
    await store.collectDelegationReport('goal', task.operationId, { operationId: 'collect-' + worker, replyMessageId: 'reply-' + worker }, { kind: 'agent', id: 'owner' })
  }
  const restored = (await openDemandStore({ root }).get('goal'))!
  expect(restored.grounding!.checks[0]!.outcome).toBe('unknown')
  expect(restored.grounding!.checks[0]!.evidence).toEqual([evidence, 'Original citation'])
  expect(restored.delegations!.map(item => item.report!.grounding.checks[0]!.evidence)).toEqual([[evidence, 'Original citation'], [evidence, 'Original citation']])
})
