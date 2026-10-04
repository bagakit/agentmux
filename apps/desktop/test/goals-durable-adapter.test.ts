import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { nameChangeRequests, unknownNameContext } from '../src/main/name-change-audit'

const initial = useAppStore.getState()
let root: string
let owner: ReturnType<typeof openDemandStore>
const proposal = { summary: 'Restore tabs', criteria: [{ id: 'tabs', text: 'Same tabs after restart' }], openQuestions: [] }
const decision = { input: 'Use repository A', candidates: [{ projectId: 'repo-a', reason: 'User chose it' }], selectedProjectId: 'repo-a', risk: 'low' as const, confirmation: 'user' as const, wikiVersion: null, recordedAt: 1, sourceSessionId: null }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'amux-goal-adapter-'))
  owner = openDemandStore({ root })
  useAppStore.setState({ demands: {}, selectedDemandId: null })
  // This original Goal-only fixture has no saved continuous arrangements.
  vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
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
  it('passes the frozen caller ID to the durable owner without inventing definition or acceptance', async () => {
    vi.mocked(api.demands.create).mockImplementationOnce(input => owner.create(input))
    await expect(useAppStore.getState().createDemand({ id: 'caller-owned', title: 'Untitled goal', description: '', status: 'backlog' })).resolves.toBe('caller-owned')
    expect(api.demands.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'caller-owned' }))
    const saved = await owner.get('caller-owned')
    expect(saved).toMatchObject({ id: 'caller-owned', description: '', status: 'backlog' })
    expect(saved!.alignment).toBeUndefined(); expect(saved!.grounding).toBeUndefined()
    expect(Object.keys(useAppStore.getState().demands)).toEqual(['caller-owned'])
  })

  it('keeps a later selection when a second save publication follows an awaited activity receipt', async () => {
    let finish!: (receipt: Awaited<ReturnType<typeof owner.addActivity>>) => void
    let saved!: Awaited<ReturnType<typeof owner.addActivity>>
    vi.mocked(api.demands.activity).mockImplementationOnce(async (id, activity) => { saved = await owner.addActivity(id, activity); return await new Promise(resolve => { finish = resolve }) })
    const creating = useAppStore.getState().createDemand({ title: 'Goal', activityLog: ['Already saved activity'] })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(useAppStore.getState().selectedDemandId).toBe('goal')
    useAppStore.setState({ selectedDemandId: 'later-goal' })
    finish(saved); await creating
    expect(useAppStore.getState().selectedDemandId).toBe('later-goal')
    expect(useAppStore.getState().demands.goal?.activityLog).toEqual(['board: Already saved activity'])
    expect((await owner.list()).map(value => value.id)).toEqual(['goal'])
  })

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
    expect(await useAppStore.getState().executeControl({ ...base, operation: 'demand.show', demandId: 'goal' })).toEqual({ operation: 'demand.show', demand: null, goalContinuations: [] })
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
  const source = ts.createSourceFile('ipc.ts', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const registration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'registerIpc')
  expect(registration?.body).toBeDefined()
  const handlers = registration!.body!.statements.filter(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const call = statement.expression
    const channel = call.arguments[0]
    return ts.isIdentifier(call.expression) && call.expression.text === 'handle'
      && channel !== undefined && ts.isStringLiteral(channel) && channel.text.startsWith('demands:')
  })
  expect(handlers.length).toBeGreaterThan(0)
  const block = handlers.map(statement => statement.getText(source)).join('\n')
  expect(block.length).toBeGreaterThan(0)
  expect(block).toContain("handle('demands:decision'")
  const routes = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const javascript = ts.transpileModule(block, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  new Function('handle', 'demands', 'nameChangeRequests', javascript)((channel: string, callback: (...args: unknown[]) => Promise<unknown>) => routes.set(channel, callback), owner, nameChangeRequests)
  expect([...routes.keys()]).toEqual(['demands:list', 'demands:create', 'demands:update', 'demands:confirmAlignment', 'demands:acceptGrounding', 'demands:delete', 'demands:linkSession', 'demands:unlinkSession', 'demands:activity', 'demands:decision'])
  await routes.get('demands:create')!({ id: 'ipc', title: 'Actual Main adapter', sessionIds: ['healthy-run'] })
  await nameChangeRequests.run({ context: unknownNameContext('private-real-handler'), operationId: 'real-update' }, () => routes.get('demands:update')!('ipc', { alignment: proposal }))
  await routes.get('demands:confirmAlignment')!('ipc', 1)
  expect((await owner.get('ipc'))!.alignment!.confirmedAt).toEqual(expect.any(Number))
  expect((await owner.get('ipc'))!.alignment!.confirmedAt).toBeGreaterThan(0)
  await nameChangeRequests.run({ context: unknownNameContext('private-real-handler'), operationId: 'real-grounding' }, () => routes.get('demands:update')!('ipc', { grounding: { alignmentRevision: 1, summary: 'Restored', checks: [{ criterionId: 'tabs', outcome: 'met', evidence: ['README.md'], note: '' }] } }))
  await routes.get('demands:acceptGrounding')!('ipc', 1, (await owner.get('ipc'))!.grounding!.submissionId)
  const actual = await openDemandStore({ root }).get('ipc')
  expect(actual!.alignment!.confirmedAt).toBeGreaterThan(0)
  expect(actual!.grounding!.acceptedAt).toBeGreaterThan(0)
  expect(actual!.sessionIds).toEqual(['healthy-run'])
})

import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { workspaceProjectId } from '../src/renderer/src/lib/workspace-projects'
import { createWorkspaceLayout, addTabPlacement } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
const human = { principal: { kind: 'device' as const, id: 'approved-phone' } }
function goalService() { return new AgentMuxRpcService({ execute: request => useAppStore.getState().executeControl(request), coreClients: () => [] }) }

it('public creation preserves the caller-held ID and permits unassigned without weakening risk or Project validation', async () => {
  vi.mocked(api.demands.create).mockImplementation(input => owner.create(input))
  const service = goalService(), input = { goalId: 'held-original-id', title: 'Untitled goal', description: '', status: 'backlog' as const, risk: 'low' as const, confirmation: 'user' as const, operationId: 'create-original' }
  const result = await service.call('goal.create', input, human)
  expect(result).toMatchObject({ goal: { id: input.goalId, projectId: null, projectName: null, description: '', sessionIds: [] }, receipt: { goalId: input.goalId } })
  expect((await owner.get(input.goalId))!.alignment).toBeUndefined(); expect((await owner.get(input.goalId))!.grounding).toBeUndefined()
  await expect(service.call('goal.create', { ...input, title: 'Overwrite original?' }, human)).rejects.toThrow(/exists/)
  expect((await owner.list()).map(goal => goal.id)).toEqual([input.goalId]); expect((await owner.get(input.goalId))!.title).toBe('Untitled goal')
  expect((await service.call('goal.inspect', { goalId: input.goalId }, human)).goal?.id).toBe(input.goalId)
  for (const changes of [{ risk: 'unknown' }, { confirmation: 'pending' }, { projectId: 'unavailable-project' }, { projectId: '' }, { projectId: null }]) {
    await expect(service.call('goal.create', { ...input, goalId: 'must-not-save', ...changes } as any, human)).rejects.toThrow()
  }
  expect(await owner.get('must-not-save')).toBeNull()
})

it('public human confirmation and result acceptance use the original owner CAS and retain report gaps', async () => {
  await useAppStore.getState().createDemand({ title: 'Actual CAS goal' })
  await useAppStore.getState().updateDemand('goal', { alignment: proposal })
  const service = goalService()
  const confirmed = await service.call('goal.confirm', { goalId: 'goal', expectedRevision: 1, operationId: 'human-confirm' }, human)
  expect(confirmed).toMatchObject({ goal: { id: 'goal', alignment: { revision: 1, confirmedAt: expect.any(Number) } }, receipt: { goalId: 'goal', confirmedRevision: 1, confirmedAt: confirmed.goal.alignment!.confirmedAt } })
  await useAppStore.getState().updateDemand('goal', { grounding: { alignmentRevision: 1, summary: 'Known gap', checks: [{ criterionId: 'tabs', outcome: 'gap', evidence: ['verification.log'], note: 'One tab differs' }] } })
  const submission = useAppStore.getState().demands.goal.grounding!.submissionId
  await expect(service.call('goal.accept', { goalId: 'goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: false }, human)).rejects.toThrow()
  expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
  const accepted = await service.call('goal.accept', { goalId: 'goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: true }, human)
  expect(accepted.receipt).toMatchObject({ goalId: 'goal', alignmentRevision: 1, submissionId: submission, acceptedAt: accepted.goal.grounding!.acceptedAt, acceptedWithGaps: true })
  expect((await openDemandStore({ root }).get('goal'))!.grounding!.checks[0].outcome).toBe('gap')
  await owner.update('goal', { alignment: { ...proposal, summary: 'Changed externally' } })
  await expect(service.call('goal.confirm', { goalId: 'goal', expectedRevision: 1 }, human)).rejects.toThrow(/changed/)
  await expect(service.call('goal.accept', { goalId: 'goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: true }, human)).rejects.toThrow(/changed|current/)
  expect((await owner.get('goal'))!.alignment!.confirmedAt).toBeNull()
})

it('rejects a replaced result submission through the original public acceptance CAS', async () => {
  await useAppStore.getState().createDemand({ title: 'Result CAS' })
  await useAppStore.getState().updateDemand('goal', { alignment: proposal })
  const service = goalService(); await service.call('goal.confirm', { goalId: 'goal', expectedRevision: 1 }, human)
  const report = { alignmentRevision: 1, summary: 'First result', checks: [{ criterionId: 'tabs', outcome: 'met' as const, evidence: ['actual.log'], note: '' }] }
  await useAppStore.getState().updateDemand('goal', { grounding: report })
  const previous = useAppStore.getState().demands.goal.grounding!.submissionId
  await owner.update('goal', { grounding: { ...report, summary: 'Another result' } })
  await expect(service.call('goal.accept', { goalId: 'goal', expectedAlignmentRevision: 1, expectedSubmissionId: previous, acceptGaps: false }, human)).rejects.toThrow(/changed/)
  expect((await owner.get('goal'))!.grounding!.acceptedAt).toBeNull()
})

it('public discussion uses the original dedicated main Mote tab and original durable input queue without acknowledging', async () => {
  await useAppStore.getState().createDemand({ title: 'Discuss original' })
  const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Main Mote', hostId: 'local', path: root, kind: 'scratch' as const }
  const tab = { ...createWorkbenchTab('dedicated-goal-tab', { kind: 'agent', phase: 'attached', regionId: 'goal-region', workspaceId: scratch.id, sessionId: 'goal-session' }), topicId: PMO_TEAMS_TOPIC_ID }
  const layout = createWorkspaceLayout('main-group')
  useAppStore.setState({ config: { ...initial.config, workspaces: [scratch], executors: {} } as any, tabs: { [tab.id]: tab }, layouts: { [scratch.id]: addTabPlacement(layout, layout.activeGroupId, tab.id)! }, demandPmoTabIds: { goal: tab.id }, agentSteerQueues: {}, runtimeEndpointWarnings: [{ hostId: 'local', availability: 'unavailable' }] as any, sessions: [{ id: 'goal-session', kind: 'agent', hostId: 'local', executorId: 'original-bot', providerId: 'codex', workspacePath: root, processState: 'running', capabilities: {}, status: { state: 'working', observedAt: 1 }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'goal-session', run: { runId: 'original-healthy-run' } } }] as any })
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.scratch, 'ensureTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID } as never)
  vi.spyOn(api.scratch, 'readTopic').mockResolvedValue({ id: PMO_TEAMS_TOPIC_ID, title: 'Main Mote', summary: '', directoryPath: 'main-mote', topicPath: 'main-mote/Topic.md', collaborators: [], soul: { path: 'SOUL.md', content: '', version: '1' } } as never)
  const auth = await rpcOwnerFixture()
  try {
    const service = new AgentMuxRpcService({ execute: request => useAppStore.getState().executeControl(request), coreClients: auth.coreClients })
    const result = await service.call('goal.discuss', { goalId: 'goal', mode: 'grill', operationId: 'discussion-operation' }, { caller: auth.credentials })
    expect(result.receipt).toEqual({ goalId: 'goal', mode: 'grill', operationId: 'discussion-operation', tabId: tab.id, agentSessionId: 'goal-session' })
    const queue = useAppStore.getState().agentSteerQueues['goal-session']!
    expect(queue).toHaveLength(1); expect(queue[0].text).toBe('Clarify goal'); expect(queue[0].agentMuxNote).toContain('existing Goal goal')
    expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState()).agentSteerQueues!['goal-session']).toEqual(queue)
    await service.call('goal.discuss', { goalId: 'goal', mode: 'open' }, { caller: auth.credentials })
    expect(useAppStore.getState().agentSteerQueues['goal-session']).toHaveLength(1)
    expect(useAppStore.getState().demandPmoTabIds).toEqual({ goal: tab.id })
    expect((await owner.get('goal'))!.alignment).toBeUndefined(); expect((await owner.get('goal'))!.grounding).toBeUndefined()
  } finally { await auth.close() }
})
it('public goal.create uses the existing renderer decision and actual durable owner', async () => {
  const workspace = { id: 'original-workspace', hostId: 'local', path: root, name: '原项目', kind: 'folder' as const }
  useAppStore.setState({ config: { ...initial.config, workspaces: [workspace] } as any, sessions: [] })
  const service = new AgentMuxRpcService({ execute: request => useAppStore.getState().executeControl(request), coreClients: () => [] })
  const result = await service.call('goal.create', { title: '手机新目标', description: '原意😀', projectId: workspaceProjectId(workspace), risk: 'medium', confirmation: 'user', operationId: 'mobile-create-original' })
  expect(result.goal).toMatchObject({ id: 'goal', title: '手机新目标', description: '原意😀', projectId: workspaceProjectId(workspace), projectName: '原项目' })
  const saved = await openDemandStore({ root }).get(result.goal.id)
  expect(saved).toMatchObject({ title: '手机新目标', description: '原意😀' }); expect(saved!.decisions).toHaveLength(1)
  expect(saved!.alignment).toBeUndefined(); expect(saved!.grounding).toBeUndefined()
})


it('native public Goal handlers persist caller identity and real human acknowledgement before returning', async () => {
  vi.mocked(api.demands.create).mockImplementationOnce(input => owner.create(input))
  const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-native-operation' }
  const created = await useAppStore.getState().executeControl({ ...base, operation: 'demand.create', demandId: 'held-native-id', title: 'Untitled goal', decision: { ...decision, selectedProjectId: null, candidates: [] } })
  expect(await owner.get('held-native-id')).not.toBeNull()
  expect(created).toMatchObject({ demand: { id: 'held-native-id' }, receipt: { demandId: 'held-native-id' } })
  await useAppStore.getState().updateDemand('held-native-id', { alignment: proposal })
  await useAppStore.getState().executeControl({ ...base, operation: 'demand.confirm', demandId: 'held-native-id', expectedRevision: 1 })
  expect(Number((await owner.get('held-native-id'))!.alignment!.confirmedAt)).toBeGreaterThan(0)
  await useAppStore.getState().updateDemand('held-native-id', { grounding: { alignmentRevision: 1, summary: 'Original result', checks: [{ criterionId: 'tabs', outcome: 'met', evidence: ['actual.log'], note: '' }] } })
  const submission = (await owner.get('held-native-id'))!.grounding!.submissionId
  await useAppStore.getState().executeControl({ ...base, operation: 'demand.accept', demandId: 'held-native-id', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: false })
  expect(Number((await owner.get('held-native-id'))!.grounding!.acceptedAt)).toBeGreaterThan(0)
})
