import { afterEach, expect, it, vi } from 'vitest'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { retainAdmittedAgentIdentity } from '../../../packages/core/src/spatial-graph'
import { connectSpaceMember } from '../../../packages/core/src/space-member-client'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial, desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import type { AppConfig } from '../src/shared/contracts'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks() })
async function original() {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'ordinary-original-admitted-Agent'
  const session = await f.d.put(sid), record = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-Core-admission')
  await f.b.spatial.settleAgentOpen(record.requestId, session, { workspaceId: 'original-b-project', phase: 'attached',
    agentPresentation: { sessionId: sid, agentSessionId: sid, hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } })
  const before = await f.b.spatial.readForLayout(), target = { reference: f.reference, regionId: record.address.regionId,
    runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedRun: session.run }
  const client = await connectSpaceMember(f.b.rpc, target); cleanup.push(() => client.dispose())
  await client.readAgentSession(sid)
  return { f, sid, session, record, before, client }
}
it('an ordinary B layout capture with no D global Session retains the original admission and the public member remains usable', async () => {
  const { f, sid, session, record, before, client } = await original()
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'B' }], executors: {},
    workspaces: [{ id: 'original-b-project', hostId: 'local', path: '/b/project', name: 'B project', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } }
  const workbench = desktopWorkbenchFromSpatial(before.graph)
  const graph = desktopSpatialGraph({ config, sessions: [], tabs: workbench.tabs, layouts: workbench.layouts,
    spaceZoneBindings: desktopBindingsFromSpatial(before.graph, config), spatialRequests: {} }, [], before.graph)
  const old = before.graph.regions.find(r => r.regionId === record.address.regionId)!
  expect(graph.regions.find(r => r.regionId === old.regionId)).toMatchObject({ creationOperationId: record.requestId, runId: old.runId, execution: old.execution })
  await f.b.spatial.commit({ expectedRevision: before.revision, graph })
  await expect(client.readAgentSession(sid)).resolves.toMatchObject({ agentSessionId: sid, run: session.run })
  const write = vi.spyOn(f.d.core, 'writeAgent').mockResolvedValue({ runId: session.run.runId, appliedByteRange: null, acceptedThroughByte: 1 })
  await client.writeAgent({ agentSessionId: sid, expectedRun: session.run, data: 'x', source: 'user' })
  expect(write).toHaveBeenCalledOnce()
  expect(write.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, expectedRun: session.run })
  expect(await f.b.core.readAgentSession(sid)).toBeNull()
})
it('the Core bulk owner accepts layout edits while retaining the same admitted occurrence against an omitted CID and wrong local execution', async () => {
  const { f, sid, session, record, before, client } = await original()
  const graph = structuredClone(before.graph), region = graph.regions.find(r => r.regionId === record.address.regionId)!
  delete region.creationOperationId
  region.execution = { hostId: 'local', runtimeId: f.b.owner.runtimeId, cwd: '/wrong-local' }; region.runId = 'wrong-local-run'
  graph.resources['private-layout-proof'] = { visible: true }
  const saved = await f.b.spatial.commit({ expectedRevision: before.revision, graph })
  expect(saved.graph.regions.find(r => r.regionId === region.regionId)).toEqual(before.graph.regions.find(r => r.regionId === region.regionId))
  expect(saved.graph.resources['private-layout-proof']).toEqual({ visible: true })
  await expect(client.readAgentSession(sid)).resolves.toMatchObject({ agentSessionId: sid, run: session.run })
})

it('retaining an admitted identity never borrows another Region or SID and never repairs the original unknown admission record', async () => {
  const { before, record } = await original(), region = before.graph.regions.find(r => r.regionId === record.address.regionId)!
  for (const changed of [{ ...region, regionId: 'another-Region' }, { ...region, tabId: 'another-Tab' }, { ...region, agentSessionId: 'another-SID' }]) {
    delete changed.creationOperationId
    const proposed = { ...structuredClone(before.graph), regions: [changed] }
    retainAdmittedAgentIdentity(proposed, before.graph)
    expect(proposed.regions[0]).toEqual(changed)
    expect(proposed.regions[0]!.creationOperationId).toBeUndefined()
  }
  const unreadable = structuredClone(before.graph)
  unreadable.resources['core:agent-open'] = { schema: 'unknown-future', original: ['keep opaque'] }
  const bytes = JSON.stringify(unreadable), proposed = structuredClone(unreadable)
  delete proposed.regions.find(r => r.regionId === region.regionId)!.creationOperationId
  retainAdmittedAgentIdentity(proposed, unreadable)
  expect(proposed.regions.find(r => r.regionId === region.regionId)!.creationOperationId).toBe(region.creationOperationId)
  expect(proposed.resources['core:agent-open']).toEqual(unreadable.resources['core:agent-open'])
  expect(JSON.stringify(unreadable)).toBe(bytes)
})
