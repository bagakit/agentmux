// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_WORKSPACE_AGENT_ORDER, executeWorkspaceAgentOrder, orderedWorkspaceAgents, restoreWorkspaceAgentOrder, workspaceAgentOrderKey } from '../src/renderer/src/lib/workspace-agent-order'
import { prepareRendererUpdate, restorePersistedUiState, useAppStore } from '../src/renderer/src/store'
import { agent, config, neighborSid, protectedFacts, startWorkfaceFixture, targetSid } from './helpers/workface-control-fixture'

const original = useAppStore.getState()
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>
const reference = (id: string) => ({ hostId: 'local', agentSessionId: id })
const keys = [workspaceAgentOrderKey(agent(targetSid)), workspaceAgentOrderKey(agent(neighborSid))]
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(original, true)
  fixture = await startWorkfaceFixture()
  useAppStore.setState({ sessions: [{ ...agent(neighborSid), createdAt: _tailFixtureEpoch(0, 0, 20) }, { ...agent(targetSid), createdAt: _tailFixtureEpoch(0, 0, 10) }], workspaceAgentOrder: {} })
  await prepareRendererUpdate(); fixture.flush.mockClear()
})
afterEach(async () => { await fixture?.stop(); vi.restoreAllMocks(); useAppStore.setState(original, true) })
async function order(input?: unknown, code = 0, displayWorkspaceId = 'resource') {
  const path = join(fixture.directory, 'order.json')
  if (input !== undefined) await writeFile(path, JSON.stringify(input))
  return await fixture.run('space.agent-order', ['space', 'agent-order', '--display-workspace', displayWorkspaceId,
    ...(input === undefined ? [] : ['--input', path]), '--operation-id', 'original-order-operation'], code)
}

describe('Workspace Agent list preference through actual compiled public CLI and Store', () => {
  it('reads creation order without writing and activity or replacement Runs never reorder the exact Sessions', async () => {
    const before = protectedFacts()
    expect(await order()).toMatchObject({ displayWorkspaceId: 'resource', storedOrder: [], effectiveOrder: [reference(targetSid), reference(neighborSid)],
      outcome: 'read', changed: false, save: null, issues: [] })
    fixture.noLifecycle(); expect(fixture.flush).not.toHaveBeenCalled(); expect(protectedFacts()).toEqual(before)
    const state = useAppStore.getState()
    const changed = state.sessions.map(session => ({ ...session, updatedAt: 100000 - session.createdAt,
      status: { state: 'running', source: 'run-process', observedAt: _tailFixtureEpoch(0, 0, 1000) }, control: { ...session.control, run: { runId: 'replacement-' + session.id } } })) as typeof state.sessions
    expect(orderedWorkspaceAgents(changed, EMPTY_WORKSPACE_AGENT_ORDER).map(value => value.id)).toEqual([targetSid, neighborSid])
  })
  it('applies the public write to the same GUI owner, persists exact keys, keeps scope and workfaces, and appends new Sessions', async () => {
    const before = protectedFacts()
    expect(await order({ order: [reference(neighborSid), reference(targetSid)], expectedOrder: [] })).toMatchObject({ outcome: 'changed', changed: true,
      storedOrder: [reference(neighborSid), reference(targetSid)], effectiveOrder: [reference(neighborSid), reference(targetSid)],
      save: { layoutApplied: false, localStorageWritten: true, storageFlushRequested: true } })
    expect(useAppStore.getState().workspaceAgentOrder).toEqual({ resource: [...keys].reverse() })
    expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.workspaceAgentOrder).toEqual({ resource: [...keys].reverse() })
    expect(restorePersistedUiState(config, { ...JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state, workspaceAgentOrder: { resource: [...keys].reverse() } }).workspaceAgentOrder).toEqual({ resource: [...keys].reverse() })
    expect(protectedFacts()).toEqual(before); fixture.noLifecycle()
    const newSession = { ...agent('new-session'), createdAt: _tailFixtureEpoch(0, 0, 30) }
    expect(orderedWorkspaceAgents([...useAppStore.getState().sessions, newSession], useAppStore.getState().workspaceAgentOrder.resource).map(value => value.id)).toEqual([neighborSid, targetSid, 'new-session'])
    expect(await useAppStore.getState().setWorkspaceAgentOrder('resource', keys)).toMatchObject({ outcome: 'changed' })
    expect((await order()).effectiveOrder).toEqual([reference(targetSid), reference(neighborSid)])
    expect(await order()).toMatchObject({ outcome: 'read', save: null })
    expect(await order(undefined, 0, 'display')).toMatchObject({ effectiveOrder: [], storedOrder: [] })
  })
  it('retains temporarily absent members on reorder, refuses stale and foreign targets locally, and resets explicitly', async () => {
    const absent = JSON.stringify(['local', 'temporarily-absent'])
    useAppStore.setState({ workspaceAgentOrder: { resource: [absent, ...keys] } })
    expect(await order({ order: [reference(neighborSid), reference(targetSid)] })).toMatchObject({ storedOrder: [reference(neighborSid), reference(targetSid), reference('temporarily-absent')] })
    const before = useAppStore.getState().workspaceAgentOrder
    expect(await order({ order: [], expectedOrder: [] }, 1)).toMatchObject({ outcome: 'refused', issues: [{ code: 'AGENT_ORDER_CONFLICT' }], save: null })
    expect(await order({ order: [{ hostId: 'other-host', agentSessionId: targetSid }] }, 1)).toMatchObject({ outcome: 'refused', issues: [{ code: 'AGENT_ORDER_MEMBER_UNCONFIRMED' }] })
    expect(await order(undefined, 1, 'missing-scope')).toMatchObject({ outcome: 'unknown', issues: [{ code: 'WORKSPACE_LIST_UNCONFIRMED' }] })
    expect(await order(undefined, 1, 'constructor')).toMatchObject({ outcome: 'unknown', storedOrder: [], issues: [{ code: 'WORKSPACE_LIST_UNCONFIRMED' }] })
    expect(useAppStore.getState().workspaceAgentOrder).toEqual(before)
    expect(await order({ order: [] })).toMatchObject({ outcome: 'changed', storedOrder: [], effectiveOrder: [reference(targetSid), reference(neighborSid)] })
    fixture.noLifecycle()
  })
  it('retains the applied preference when the original storage owner reports an unknown flush', async () => {
    vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('Original storage flush unavailable'))
    const result = await order({ order: [reference(neighborSid), reference(targetSid)] }, 1)
    expect(result).toMatchObject({ outcome: 'partial', changed: true, storedOrder: [reference(neighborSid), reference(targetSid)],
      save: { localStorageWritten: true, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'Original storage flush unavailable' }, issues: [{ code: 'AGENT_ORDER_SAVE_UNCONFIRMED' }] })
    expect((await order()).storedOrder).toEqual(result.storedOrder); fixture.noLifecycle()
  })
  it('restores independently valid scopes and canonical original keys without inventing live Sessions', () => {
    expect(restoreWorkspaceAgentOrder({ resource: [...keys, keys[0], 'bad'], missing: [JSON.stringify(['host', 'saved'])], invalid: 3 })).toEqual({ resource: keys, missing: [JSON.stringify(['host', 'saved'])] })
  })
  it('does not borrow a Core topology acknowledgement for the separate client preference batch', async () => {
    const result = await executeWorkspaceAgentOrder({ get: useAppStore.getState, set: vi.fn(), save: async () => ({
      layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null
    }) }, { schemaVersion: 5, requestId: 'separate-preference-write', operation: 'space.agent-order', displayWorkspaceId: 'resource', order: [] })
    expect(result.save).toEqual({ layoutApplied: false, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null })
  })
  it('uses original canonical controls for public order when list items have presentation aliases', async () => {
    const original = agent(targetSid)
    const alias = { ...original, id: 'list-presentation-alias' }
    useAppStore.setState({ sessions: [alias, original] })
    expect(await order()).toMatchObject({ effectiveOrder: [reference(targetSid)] })
    expect(await order({ order: [reference(targetSid)] })).toMatchObject({ outcome: 'changed', storedOrder: [reference(targetSid)], effectiveOrder: [reference(targetSid)] })
    expect(useAppStore.getState().workspaceAgentOrder.resource).toEqual([workspaceAgentOrderKey(original)])
    expect(useAppStore.getState().sessions).toEqual([alias, original])
    fixture.noLifecycle()
  })
})
