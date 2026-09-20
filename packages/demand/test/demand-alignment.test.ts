import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import type { UpdateDemandInput } from '../src/demand-types.js'
import { isDemandEvidenceReference, type DemandAlignmentProposal, type DemandGroundingProposal } from '../src/goals.js'

const roots: string[] = []
const execute = promisify(execFile)
const cli = new URL('../dist/bin/agentmux-demand.js', import.meta.url).pathname
const goal: DemandAlignmentProposal = { summary: 'Keep the workbench after restart', criteria: [{ id: "restart's-layout", text: 'Tabs and regions remain visible' }], openQuestions: [] }
const result: DemandGroundingProposal = { alignmentRevision: 1, summary: 'Restart was exercised', checks: [{ criterionId: "restart's-layout", outcome: 'met', evidence: ['verification.log:12'], note: '' }] }

async function owner() {
  const root = await mkdtemp(join(tmpdir(), 'amux-goal-')); roots.push(root)
  const store = openDemandStore({ root })
  await store.create({ id: 'goal', title: 'Restart', description: 'Original user intent\nkept verbatim', status: 'in_progress', sessionIds: ['healthy-run'] })
  return { root, store }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('durable Goal alignment and result acceptance', () => {
  it('retains existing Domain/Session facts without a proposal and restores actual acknowledgements across processes', async () => {
    const { root, store } = await owner()
    expect(await openDemandStore({ root }).get('goal')).toMatchObject({ status: 'in_progress', sessionIds: ['healthy-run'], description: 'Original user intent\nkept verbatim' })
    expect((await store.get('goal'))?.alignment).toBeUndefined()
    const proposed = await store.proposeAlignment('goal', goal)
    expect(proposed.demand.alignment).toEqual({ ...goal, revision: 1, confirmedAt: null })
    const confirmed = await store.confirmAlignment('goal', 1)
    expect(confirmed.demand.alignment!.confirmedAt).toBeGreaterThan(0)
    const grounded = await store.proposeGrounding('goal', result)
    expect(grounded.demand.grounding!.submissionId).toMatch(/^grounding_/u)
    const accepted = await store.acceptGrounding('goal', 1, grounded.demand.grounding!.submissionId)
    expect(accepted.demand.grounding!.acceptedAt).toBeGreaterThan(0)
    const output = await execute(process.execPath, [cli, '--root', root, 'show', '--id', 'goal'])
    expect(JSON.parse(output.stdout).demand).toEqual(accepted.demand)
    expect(accepted.demand.sessionIds).toEqual(['healthy-run'])
    expect(accepted.demand.status).toBe('in_progress')
  }, 30_000)

  it('keeps same-content acknowledgements, invalidates changed standards and binds the exact submission', async () => {
    const { store } = await owner()
    await store.proposeAlignment('goal', goal)
    const confirmed = (await store.confirmAlignment('goal', 1)).demand.alignment!
    expect((await store.proposeAlignment('goal', goal)).demand.alignment).toEqual(confirmed)
    await store.proposeGrounding('goal', result)
    const accepted = (await store.acceptGrounding('goal', 1, (await store.get('goal'))!.grounding!.submissionId)).demand.grounding!
    expect((await store.proposeGrounding('goal', result)).demand.grounding).toEqual(accepted)
    expect((await store.update('goal', { title: 'New label', description: 'More original context' })).demand.alignment).toEqual(confirmed)
    const changed = await store.proposeGrounding('goal', { ...result, summary: 'New results' })
    expect(changed.demand.grounding!.acceptedAt).toBeNull()
    expect(changed.demand.grounding!.submissionId).not.toBe(accepted.submissionId)
    await expect(store.acceptGrounding('goal', 1, accepted.submissionId)).rejects.toThrow(/changed/u)
    const revised = await store.proposeAlignment('goal', { ...goal, summary: 'Stronger target' })
    expect(revised.demand.alignment).toEqual({ ...goal, summary: 'Stronger target', revision: 2, confirmedAt: null })
    expect(revised.demand.grounding).toEqual(changed.demand.grounding)
    await expect(store.confirmAlignment('goal', 1)).rejects.toThrow(/changed/u)
    await store.confirmAlignment('goal', 2)
    await expect(store.acceptGrounding('goal', 2, changed.demand.grounding!.submissionId)).rejects.toThrow(/earlier goal/u)
    await expect(store.proposeGrounding('goal', result)).rejects.toThrow(/current goal revision/u)
  })

  it('cannot confirm an empty standard or unresolved questions, and rejects stale confirmation atomically', async () => {
    const { store } = await owner()
    await store.proposeAlignment('goal', { ...goal, criteria: [] })
    const before = await store.snapshot()
    await expect(store.confirmAlignment('goal', 1)).rejects.toThrow(/at least one/u)
    expect(await store.snapshot()).toEqual(before)
    await store.proposeAlignment('goal', { ...goal, openQuestions: ['Which layout?'] })
    await expect(store.confirmAlignment('goal', 2)).rejects.toThrow(/open questions/u)
  })

  it('rejects duplicate standards and duplicate or unknown result checks atomically', async () => {
    const { store } = await owner()
    await store.proposeAlignment('goal', goal)
    const before = await store.snapshot()
    await expect(store.proposeAlignment('goal', { ...goal, criteria: [goal.criteria[0]!, goal.criteria[0]!] })).rejects.toThrow(/unique/u)
    await expect(store.proposeGrounding('goal', { ...result, checks: [result.checks[0]!, result.checks[0]!] })).rejects.toThrow(/unique/u)
    await expect(store.proposeGrounding('goal', { ...result, checks: [{ ...result.checks[0]!, criterionId: 'invented-criterion' }] })).rejects.toThrow(/unknown success criterion/u)
    expect(await store.snapshot()).toEqual(before)
  })

  it.each([
    { checks: [] },
    { checks: [{ ...result.checks[0]!, outcome: 'unknown' as const }] },
    { checks: [{ ...result.checks[0]!, evidence: [] }] },
    { checks: [{ ...result.checks[0]!, evidence: ['All tests passed'] }] }
  ])('rejects ungrounded acceptance without changing the owner snapshot: %j', async patch => {
    const { store } = await owner()
    await store.proposeAlignment('goal', goal); await store.confirmAlignment('goal', 1)
    const grounded = await store.proposeGrounding('goal', { ...result, ...patch })
    const before = await store.snapshot()
    await expect(store.acceptGrounding('goal', 1, grounded.demand.grounding!.submissionId, true)).rejects.toThrow()
    expect(await store.snapshot()).toEqual(before)
  })

  it('accepts explicit remaining gaps honestly, while ordinary acceptance and unexplained gaps fail', async () => {
    const { store } = await owner()
    await store.proposeAlignment('goal', goal); await store.confirmAlignment('goal', 1)
    const gap = { ...result, checks: [{ ...result.checks[0]!, outcome: 'gap' as const, note: 'One retired session cannot resume' }] }
    const grounded = await store.proposeGrounding('goal', gap)
    await expect(store.acceptGrounding('goal', 1, grounded.demand.grounding!.submissionId)).rejects.toThrow(/remaining gaps/u)
    const accepted = await store.acceptGrounding('goal', 1, grounded.demand.grounding!.submissionId, true)
    expect(accepted.demand.grounding!.checks).toEqual(gap.checks)
    expect(accepted.demand.grounding!.acceptedAt).toBeGreaterThan(0)
    const unexplained = await store.proposeGrounding('goal', { ...gap, checks: [{ ...gap.checks[0]!, note: '' }] })
    await expect(store.acceptGrounding('goal', 1, unexplained.demand.grounding!.submissionId, true)).rejects.toThrow(/Describe/u)
  })

  it.each([
    { confirmedAt: 1 }, { acceptedAt: 1 }, { revision: 10 }, { submissionId: 'forged' },
    { alignment: { ...goal, confirmedAt: 1 } }, { alignment: { ...goal, revision: 10 } },
    { grounding: { ...result, acceptedAt: 1 } }, { grounding: { ...result, submissionId: 'forged' } }
  ])('rejects Agent forged acknowledgement fields atomically: %j', async patch => {
    const { store } = await owner(); await store.proposeAlignment('goal', goal)
    const before = await store.snapshot()
    await expect(store.update('goal', patch as UpdateDemandInput)).rejects.toThrow()
    expect(await store.snapshot()).toEqual(before)
  })

  it('runs real standalone CLI proposals and cannot use it to acknowledge or forge acceptance', async () => {
    const { root, store } = await owner()
    const run = async (...args: string[]) => execute(process.execPath, [cli, '--root', root, ...args])
    expect(JSON.parse((await run('propose-alignment', '--id', 'goal', '--proposal', JSON.stringify(goal))).stdout).demand.alignment).toEqual({ ...goal, revision: 1, confirmedAt: null })
    expect(JSON.parse((await run('update', '--id', 'goal', '--grounding', JSON.stringify(result))).stdout).demand.grounding.checks).toEqual(result.checks)
    const before = await store.snapshot()
    await expect(run('update', '--id', 'goal', '--alignment', JSON.stringify({ ...goal, confirmedAt: 10 }))).rejects.toThrow()
    await expect(run('update', '--id', 'goal', '--accepted-at', '10')).rejects.toThrow()
    await expect(run('confirm-alignment', '--id', 'goal')).rejects.toThrow()
    expect(await store.snapshot()).toEqual(before)
  }, 30_000)

  it.each(['README.md', 'package.json', 'verification.log:12', 'Dockerfile:12', 'src/main.ts:4:2', '/tmp/receipt.txt', 'https://example.org/result', 'file:///tmp/result'])('recognizes generic locatable references without claiming verification: %s', reference => {
    expect(isDemandEvidenceReference(reference)).toBe(true)
  })
  it.each(['', 'Tests passed', 'Trust me', 'folder/', 'https://', 'line\nfile.txt'])('rejects empty or self-reported evidence: %s', reference => {
    expect(isDemandEvidenceReference(reference)).toBe(false)
  })
})
