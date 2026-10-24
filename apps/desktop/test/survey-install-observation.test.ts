// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { inspectDesktopClient } from '../src/main/client-observation'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { parseDesktopClientObservation, parseDesktopClientObservationForInstall } from '../src/shared/client-observation'
import { startWorkfaceFixture, protectedFacts, tabId, regionIdA } from './helpers/workface-control-fixture'

const initial = useAppStore.getState()
const renderer = { kind: 'bundled' as const, id: 'a'.repeat(64), identity: { shell: 'original-shell', ctxmux: 'original-native' } }
const identity = { schema: 'agentmux.package-identity.v1' as const, sourceCommit: 'original-source', sourceTree: 'original-tree', appVersion: '1', platform: process.platform, arch: process.arch }
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>>, bridge: DesktopControlIpcBridge, server: AgentMuxControlServer,
  rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>
beforeEach(async () => {
  useAppStore.setState(initial, true)
  fixture = await startWorkfaceFixture()
  bridge = new DesktopControlIpcBridge({ isAvailable: () => true,
    sendRequest: input => { void useAppStore.getState().executeControl(input).then(result => bridge.accept({ requestId: input.requestId, ok: true, result })) },
    sendCancellation: () => { throw new Error('No observation cancellation expected') } })
  const socketPath = join(fixture.directory, 'survey-inspection.sock')
  server = new AgentMuxControlServer({ socketPath,
    execute: input => inspectDesktopClient(input, { pid: process.pid, package: identity, renderer: () => renderer,
      generation: () => 1, runtimes: () => [], execute: request => bridge.execute(request) }) })
  await server.start()
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
})
afterEach(async () => {
  await rpc?.dispose(); await server?.stop(); bridge?.dispose(); await fixture?.stop()
  if (fixture) await rm(fixture.directory, { recursive: true, force: true })
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})
const inspect = async () => parseDesktopClientObservation((await rpc.call('app.inspect', {})).observation)

it('[survey-install-observation] public RPC through Main and Store reads the complete stored Survey without catalog filtering, writes or private bodies', async () => {
  const selection = { zoneId: 'retained-selected-zone', selection: [{ tabId, regionId: regionIdA }], active: { tabId, regionId: regionIdA } }
  const organization = { ungrouped: ['explicit-member-b'], groups: [{ groupId: 'retained-group', name: 'Original collection', collapsed: true, zoneIds: ['missing-original-zone', 'closed-original-slot', 'explicit-member-a'] }] }
  useAppStore.setState({ surveyCollectedZones: { 'explicit-member-b': true, 'explicit-member-a': true, 'missing-original-zone': true }, surveyOrganization: organization, surveyZoneSelection: selection,
    agentComposerDrafts: { original: 'PRIVATE UNSENT BODY' } })
  const state = useAppStore.getState(), before = protectedFacts(), changed = vi.fn(), unsubscribe = useAppStore.subscribe(changed)
  const flush = vi.spyOn(api.ui, 'requestStorageFlush'); flush.mockClear()
  try {
    const observation = await inspect()
    expect(observation.workbench.survey).toEqual({ collectedZoneIds: ['explicit-member-b', 'explicit-member-a', 'missing-original-zone'], organization, selection })
    expect(observation.workbench.survey!.organization.groups[0]!.zoneIds).toContain('closed-original-slot')
    expect(observation.workbench.survey!.selection!.zoneId).not.toBe(observation.workbench.activeWorkspaceId)
    expect(JSON.stringify(observation)).not.toContain('PRIVATE UNSENT BODY')
    expect(useAppStore.getState()).toBe(state); expect(protectedFacts()).toEqual(before)
    expect(changed).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled(); fixture.noLifecycle()
    const legacy = structuredClone(observation); delete legacy.workbench.survey
    expect(parseDesktopClientObservation(legacy).workbench.survey).toBeUndefined()
    expect(parseDesktopClientObservationForInstall(legacy).workbench.survey).toBeUndefined()
  } finally { unsubscribe() }
})

it('[survey-install-observation] a real empty Store observation is distinct from an older absent field', async () => {
  useAppStore.setState({ surveyCollectedZones: {}, surveyOrganization: { ungrouped: [], groups: [] }, surveyZoneSelection: null })
  const observation = await inspect()
  expect(observation.workbench.survey).toEqual({ collectedZoneIds: [], organization: { ungrouped: [], groups: [] }, selection: null })
  const legacy = structuredClone(observation); delete legacy.workbench.survey
  expect(parseDesktopClientObservationForInstall(legacy).workbench).not.toHaveProperty('survey')
  fixture.noLifecycle()
})

it('[survey-install-observation] current shared codecs retain exact valid preferences and refuse malformed or duplicate facts', async () => {
  const observation = await inspect()
  for (const survey of [null, { ...observation.workbench.survey, collectedZoneIds: ['same', 'same'] },
    { ...observation.workbench.survey, organization: { ungrouped: [], groups: [{ groupId: 'g', name: 'Name', collapsed: 'yes', zoneIds: [] }] } },
    { ...observation.workbench.survey, selection: { zoneId: 'z', selection: [], active: { tabId: 't', regionId: 3 } } },
    { ...observation.workbench.survey, extra: 'not a stored fact' }]) {
    const malformed = { ...observation, workbench: { ...observation.workbench, survey } }
    expect(() => parseDesktopClientObservation(malformed)).toThrow()
    expect(() => parseDesktopClientObservationForInstall(malformed)).toThrow()
  }
  fixture.noLifecycle()
})
