// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { PMO_TEAMS_TOPIC_ID, isPrimaryMoteSpace } from '../../../packages/core/src/mote-preferences'
import { PMO_TEAMS_TOPIC_ID as hostPrimary, isPmoTopicId, scratchTopicDirectoryName } from '../../host/src/mote-topic-model'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseRpcControlResult, rpcControlResult } from '../../../packages/core/src/rpc-business-codec'
import { ObjectCliProbe } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { AgentMuxSpaceCatalog } from '../../../packages/core/src/space-control'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { executeSpatialControl, type SpatialControlPorts, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'

const probes: ObjectCliProbe[] = []
afterEach(async () => { for (const probe of probes.splice(0)) await probe.stop(); vi.restoreAllMocks() })

function owner() {
  const workspace = { id: '__scratch__', hostId: 'local', path: fixturePath('primary-mote'), name: 'Topics', kind: 'folder' as const }
  const topics: ScratchTopicSnapshot[] = ['launcher:leader', 'launcher:neighbor'].map((id, index) => {
    const directoryPath = workspace.path + '/' + scratchTopicDirectoryName(id)
    return { id, title: index === 0 ? 'Renamed original collaborator' : 'Mote', directoryPath, topicPath: directoryPath + '/topic.md', summary: '', collaborators: [],
      soul: { path: directoryPath + '/SOUL.md', content: '# Original identity', version: 'saved' } }
  })
  const state: SpatialWorkbench = { config: { version: 9, workspaces: [workspace], hosts: [{ id: 'local', kind: 'local', label: 'Original Mac' }], executors: {}, appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } },
    sessions: [], tabs: {}, layouts: {}, spaceZoneBindings: {}, spatialRequests: {} }
  const mutation = vi.fn(() => { throw new Error('Reading the original Mote identity cannot mutate its workface or lifecycle.') })
  const presentation = vi.fn(async (catalog: AgentMuxSpaceCatalog) => catalog.spaces.filter(space => space.kind === 'mote').map(space => ({
    spaceId: space.spaceId, ...(space.topicId === 'launcher:leader' ? { glyph: 'custom' } : { preset: 'primary-mote' as const }) })))
  const ports: SpatialControlPorts = { get: () => state, topics: async () => topics, appearance: presentation,
    patch: mutation, launch: mutation, creation: mutation, createResource: mutation, attach: mutation, save: mutation, focus: mutation, isFocused: () => false, notice: mutation, closing: () => false }
  const service = new AgentMuxRpcService({ coreClients: () => [], execute: request => {
    if (request.operation !== 'space.ls' && request.operation !== 'space.inspect') throw new Error('Only original spatial reads are in scope.')
    return executeSpatialControl(ports, request)
  } })
  return { workspace, topics, ports, service, mutation, presentation }
}

it('shares the persisted primary identity with the original Host and ignores names, appearance and other object kinds', () => {
  expect(PMO_TEAMS_TOPIC_ID).toBe('launcher:leader')
  expect(hostPrimary).toBe(PMO_TEAMS_TOPIC_ID)
  expect(isPmoTopicId('launcher:leader')).toBe(true)
  expect(isPmoTopicId('launcher:neighbor')).toBe(false)
  expect(isPrimaryMoteSpace({ kind: 'mote', topicId: 'launcher:leader' })).toBe(true)
  for (const kind of ['topic', 'folder', 'container'] as const) expect(isPrimaryMoteSpace({ kind, topicId: 'launcher:leader' })).toBe(false)
  expect(isPrimaryMoteSpace({ kind: 'mote' })).toBe(false)
  expect(isPrimaryMoteSpace({ kind: 'mote', topicId: 'launcher:neighbor' })).toBe(false)
})

it('consumes the existing exact topic identity through the original owner, strict public RPC, SDK and compiled CLI', async () => {
  const f = owner()
  expect(await f.service.call('space.ls', { target: {}, presentation: true }, { transport: 'unix', principal: { kind: 'user', id: 'fixture-reader' } })).toHaveProperty('catalog.spaces')
  const probe = new ObjectCliProbe(request => f.service.call(request.method as 'space.ls', request.params as never,
    { transport: 'unix', principal: { kind: 'user', id: 'fixture-reader' } }))
  probes.push(probe); await probe.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } })
  try {
    const result = await sdk.call('space.ls', { target: {}, presentation: true })
    const motes = result.catalog.spaces.filter(space => space.kind === 'mote')
    expect(motes.map(space => space.topicId)).toEqual(['launcher:leader', 'launcher:neighbor'])
    const selected = motes.filter(isPrimaryMoteSpace)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.hostId).toBe(f.workspace.hostId)
    const primary = selected[0]!
    expect(result.catalog.appearance?.find(value => value.spaceId === primary.spaceId)).toMatchObject({ glyph: 'custom' })
    expect(result.catalog.appearance?.find(value => value.spaceId !== primary.spaceId)).toMatchObject({ preset: 'primary-mote' })
    for (const verb of ['ls', 'inspect']) {
      const read = await probe.run(['space', verb, '--space', primary.spaceId, '--presentation'])
      expect(read.code).toBe(0); expect(read.stderr).toBe('')
      const body = JSON.parse(read.stdout).result as { catalog: AgentMuxSpaceCatalog }
      expect(body.catalog.spaces.filter(isPrimaryMoteSpace)).toEqual([primary])
      expect(probe.requests.at(-1)?.params).toEqual({ target: { spaceId: primary.spaceId }, presentation: true })
    }
    const count = f.presentation.mock.calls.length
    const topology = await sdk.call('space.ls', { target: {} })
    expect(topology.catalog.spaces.filter(isPrimaryMoteSpace)).toEqual([primary])
    expect(topology.catalog).not.toHaveProperty('appearance')
    expect(f.presentation).toHaveBeenCalledTimes(count)
    const malformed = { ...result.catalog, spaces: result.catalog.spaces.map(space => space.spaceId === primary.spaceId ? { ...space, topicId: true } : space) }
    expect(() => parseRpcControlResult('space.ls', rpcControlResult('space.ls', { operation: 'space.ls', catalog: malformed as never }), { target: {} })).toThrow()
    const missing = { ...primary }; delete missing.topicId
    expect(isPrimaryMoteSpace(missing)).toBe(false)
    expect(f.mutation).not.toHaveBeenCalled()
  } finally { await sdk.dispose() }
}, 30000)
