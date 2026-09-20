import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'

const initial = useAppStore.getState()
let root: string
let owner: ReturnType<typeof openDemandStore>
const proposal = { summary: 'Restore tabs', criteria: [{ id: 'tabs', text: 'Same tabs after restart' }], openQuestions: [] }
const decision = { input: 'Use repository A', candidates: [{ projectId: 'repo-a', reason: 'User chose it' }], selectedProjectId: 'repo-a', risk: 'low' as const, confirmation: 'user' as const, wikiVersion: null, recordedAt: 1, sourceSessionId: null }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amux-goal-adapter-'))
  owner = openDemandStore({ root })
  useAppStore.setState({ demands: {}, selectedDemandId: null })
  vi.spyOn(api.demands, 'create').mockImplementation(input => owner.create({ ...input, id: 'goal' }))
  vi.spyOn(api.demands, 'list').mockImplementation(() => owner.list())
  vi.spyOn(api.demands, 'update').mockImplementation((id, patch) => owner.update(id, patch))
  vi.spyOn(api.demands, 'confirmAlignment').mockImplementation((id, revision) => owner.confirmAlignment(id, revision))
  vi.spyOn(api.demands, 'acceptGrounding').mockImplementation((id, revision, submission, gaps) => owner.acceptGrounding(id, revision, submission, gaps))
  vi.spyOn(api.demands, 'activity').mockImplementation((id, activity) => owner.addActivity(id, activity))
  vi.spyOn(api.demands, 'decision').mockImplementation((id, entry) => owner.addDecision(id, entry))
  vi.spyOn(api.demands, 'linkSession').mockImplementation((id, session) => owner.linkSession(id, session))
  vi.spyOn(api.demands, 'unlinkSession').mockImplementation((id, session) => owner.unlinkSession(id, session))
})
afterEach(async () => { vi.restoreAllMocks(); useAppStore.setState(initial, true); await rm(root, { recursive: true, force: true }) })

describe('actual durable owner to Renderer projection', () => {
  it('reloads a changed owner proposal after CAS rejection without retrying unread acknowledgement', async () => {
    await useAppStore.getState().createDemand({ title: 'Goal', source: 'session', sessionIds: ['healthy-run'], decisionLog: [decision] })
    await useAppStore.getState().updateDemand('goal', { alignment: proposal })
    const read = useAppStore.getState().demands.goal
    await openDemandStore({ root }).proposeAlignment('goal', { ...proposal, summary: 'Changed by another caller' })
    await expect(useAppStore.getState().confirmDemandGoal('goal', 1)).rejects.toThrow(/changed/u)
    expect(useAppStore.getState().demands.goal).toEqual(read)
    await useAppStore.getState().refreshDemand('goal')
    expect(useAppStore.getState().demands.goal).toMatchObject({ source: 'session', decisionLog: [decision], sessionIds: ['healthy-run'], alignment: { revision: 2, summary: 'Changed by another caller', confirmedAt: null } })
    expect(api.demands.confirmAlignment).toHaveBeenCalledTimes(1)
    const refreshed = useAppStore.getState().demands.goal
    vi.mocked(api.demands.list).mockRejectedValueOnce(new Error('Owner read unavailable'))
    await expect(useAppStore.getState().refreshDemand('goal')).rejects.toThrow('Owner read unavailable')
    expect(useAppStore.getState().demands.goal).toEqual(refreshed)
    vi.mocked(api.demands.list).mockResolvedValueOnce([])
    await expect(useAppStore.getState().refreshDemand('goal')).rejects.toThrow(/saved view is kept/u)
    expect(useAppStore.getState().demands.goal).toEqual(refreshed)
  })

  it('reads current owner facts for public Control show/list while keeping unknown saved views', async () => {
    await useAppStore.getState().createDemand({ title: 'Goal', source: 'session', decisionLog: [decision] })
    await owner.proposeAlignment('goal', proposal)
    const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'read-fresh' }
    expect(await useAppStore.getState().executeControl({ ...base, operation: 'demand.show', demandId: 'goal' })).toMatchObject({ demand: { alignment: { ...proposal, revision: 1, confirmedAt: null } } })
    await owner.proposeAlignment('goal', { ...proposal, summary: 'Latest summary' })
    expect(await useAppStore.getState().executeControl({ ...base, operation: 'demand.list' })).toMatchObject({ demands: [{ id: 'goal', source: 'session', alignment: { revision: 2, summary: 'Latest summary' } }] })
    const retained = useAppStore.getState().demands.goal
    await owner.remove('goal')
    expect(await useAppStore.getState().executeControl({ ...base, operation: 'demand.show', demandId: 'goal' })).toEqual({ operation: 'demand.show', demand: null })
    expect(useAppStore.getState().demands.goal).toEqual(retained)
  })

  it('awaits actual Control proposal writes and returns their complete current facts', async () => {
    await useAppStore.getState().createDemand({ title: 'Goal', description: 'Original intent' })
    const request = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'goal-proposal', operation: 'demand.update' as const, demandId: 'goal', patch: { alignment: proposal } }
    const response = await useAppStore.getState().executeControl(request)
    expect(response).toMatchObject({ operation: 'demand.update', demand: { id: 'goal', alignment: { ...proposal, revision: 1, confirmedAt: null } }, receipt: { demandId: 'goal', updatedAt: expect.any(Number) } })
    expect((await openDemandStore({ root }).get('goal'))!.alignment).toEqual({ ...proposal, revision: 1, confirmedAt: null })
    vi.mocked(api.demands.update).mockRejectedValueOnce(new Error('Actual durable receipt unavailable'))
    await expect(useAppStore.getState().executeControl({ ...request, patch: { alignment: { ...proposal, summary: 'Another target' } } })).rejects.toThrow('Actual durable receipt unavailable')
    expect(useAppStore.getState().demands.goal!.alignment!.revision).toBe(1)
  })

  it('waits for save before publishing a Goal, preserves user intent and persists routing/activity receipts', async () => {
    let finish!: (receipt: Awaited<ReturnType<typeof owner.create>>) => void
    vi.mocked(api.demands.create).mockImplementationOnce(async input => await new Promise(async resolve => { finish = resolve; await owner.create({ ...input, id: 'goal' }) }))
    const creating = useAppStore.getState().createDemand({ title: 'Tabs', description: 'Original user words\n  with indentation', source: 'session', sessionIds: ['healthy-run'], decisionLog: [decision], activityLog: ['Started discussion'] })
    expect(useAppStore.getState().demands).toEqual({})
    await vi.waitFor(async () => { expect(await owner.get('goal')).not.toBeNull() })
    const saved = (await owner.get('goal'))!
    finish({ schema: 'agentmux.demand-receipt.v1', operation: 'create', operationId: 'creation', revision: 1, demand: saved })
    await expect(creating).resolves.toBe('goal')
    const persisted = (await openDemandStore({ root }).get('goal'))!
    expect(persisted.description).toBe('Original user words\n  with indentation')
    expect(persisted.activities.map(entry => entry.message)).toEqual(['Started discussion'])
    expect(persisted.decisions.map(entry => entry.decision)).toEqual(['repo-a'])
    expect(persisted.sessionIds).toEqual(['healthy-run'])
    expect(useAppStore.getState().demands.goal).toMatchObject({ source: 'session', decisionLog: [decision], activityLog: ['board: Started discussion'] })
  })

  it('does not publish failed creation or failed proposals, and shows a saved Goal when later audit persistence fails', async () => {
    vi.mocked(api.demands.create).mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(useAppStore.getState().createDemand({ title: 'New', description: 'Keep draft' })).rejects.toThrow('Disk unavailable')
    expect(useAppStore.getState().demands).toEqual({})
    vi.mocked(api.demands.decision).mockRejectedValueOnce(new Error('Audit unavailable'))
    await expect(useAppStore.getState().createDemand({ title: 'Saved', description: 'Actual intent', decisionLog: [decision] })).rejects.toThrow(/was saved.*routing record was not saved/u)
    expect(useAppStore.getState().demands.goal?.description).toBe('Actual intent')
    expect(useAppStore.getState().demands.goal?.decisionLog).toEqual([])
    expect((await owner.get('goal'))?.title).toBe('Saved')
    const before = useAppStore.getState().demands.goal
    vi.mocked(api.demands.update).mockRejectedValueOnce(new Error('Write rejected'))
    await expect(useAppStore.getState().updateDemand('goal', { alignment: proposal })).rejects.toThrow('Write rejected')
    expect(useAppStore.getState().demands.goal).toEqual(before)
  })

  it('projects saved metadata but retains only acknowledged routing decisions after a later audit failure', async () => {
    await useAppStore.getState().createDemand({ title: 'Goal', decisionLog: [decision] })
    vi.mocked(api.demands.decision).mockRejectedValueOnce(new Error('Second decision write failed'))
    const next = { ...decision, input: 'A new routing decision', recordedAt: 2 }
    await expect(useAppStore.getState().updateDemand('goal', { title: 'Saved label', decisionLog: [decision, next] })).rejects.toThrow(/changes were saved.*routing record/u)
    expect(useAppStore.getState().demands.goal).toMatchObject({ title: 'Saved label', decisionLog: [decision] })
    expect((await owner.get('goal'))!.decisions).toHaveLength(1)
  })

  it('projects only acknowledged facts and retains source, routing, Session and exact user acceptance through failure and reopen', async () => {
    const state = useAppStore.getState()
    await state.createDemand({ title: 'Tabs', description: 'User intent', source: 'session', sessionIds: ['healthy-run'], decisionLog: [decision] })
    await state.updateDemand('goal', { alignment: proposal })
    expect(useAppStore.getState().demands.goal!.alignment?.confirmedAt).toBeNull()
    await state.confirmDemandGoal('goal', 1)
    await state.updateDemand('goal', { grounding: { alignmentRevision: 1, summary: 'Tabs restored', checks: [{ criterionId: 'tabs', outcome: 'met', evidence: ['verification.log:12'], note: '' }] } })
    const submission = useAppStore.getState().demands.goal!.grounding!.submissionId
    await state.acceptDemandResult('goal', 1, submission)
    expect(useAppStore.getState().demands.goal).toMatchObject({ source: 'session', decisionLog: [decision], sessionIds: ['healthy-run'], alignment: { confirmedAt: expect.any(Number) }, grounding: { acceptedAt: expect.any(Number), submissionId: submission } })
    const before = useAppStore.getState().demands.goal
    await expect(state.confirmDemandGoal('goal', 100)).rejects.toThrow(/changed/u)
    await expect(state.acceptDemandResult('goal', 1, 'stale')).rejects.toThrow(/changed/u)
    expect(useAppStore.getState().demands.goal).toEqual(before)
    const restored = (await openDemandStore({ root }).get('goal'))!
    expect(restored.alignment).toEqual(before!.alignment)
    expect(restored.grounding).toEqual(before!.grounding)
    expect(restored.sessionIds).toEqual(['healthy-run'])
    vi.mocked(api.demands.linkSession).mockRejectedValueOnce(new Error('Link write unavailable'))
    await expect(state.updateDemand('goal', { title: 'Saved new label', sessionIds: ['healthy-run', 'new-run'] })).rejects.toThrow(/changes were saved.*Session link/u)
    expect(useAppStore.getState().demands.goal).toMatchObject({ title: 'Saved new label', sessionIds: ['healthy-run'] })
  })
})

it('invokes the actual registered Main Demand handlers against the unique filesystem owner', async () => {
  const main = await readFile(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const start = main.indexOf("  handle('demands:list'")
  const end = main.indexOf('\n  /**', start)
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
  const block = main.slice(start, end)
  expect(block.length).toBeGreaterThan(0)
  expect(block).toContain("handle('demands:decision'")
  const routes = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const javascript = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  new Function('handle', 'demands', javascript)((channel: string, callback: (...args: unknown[]) => Promise<unknown>) => routes.set(channel, callback), owner)
  expect([...routes.keys()]).toEqual(['demands:list', 'demands:create', 'demands:update', 'demands:confirmAlignment', 'demands:acceptGrounding', 'demands:delete', 'demands:linkSession', 'demands:unlinkSession', 'demands:activity', 'demands:decision'])
  await routes.get('demands:create')!({ id: 'ipc', title: 'Actual Main adapter', sessionIds: ['healthy-run'] })
  await routes.get('demands:update')!('ipc', { alignment: proposal })
  await routes.get('demands:confirmAlignment')!('ipc', 1)
  expect((await owner.get('ipc'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  await routes.get('demands:update')!('ipc', { grounding: { alignmentRevision: 1, summary: 'Restored', checks: [{ criterionId: 'tabs', outcome: 'met', evidence: ['README.md'], note: '' }] } })
  await routes.get('demands:acceptGrounding')!('ipc', 1, (await owner.get('ipc'))!.grounding!.submissionId)
  const actual = await openDemandStore({ root }).get('ipc')
  expect(actual!.alignment!.confirmedAt).toBeGreaterThan(0)
  expect(actual!.grounding!.acceptedAt).toBeGreaterThan(0)
  expect(actual!.sessionIds).toEqual(['healthy-run'])
})
