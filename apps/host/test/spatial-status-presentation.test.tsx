import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createWorkbenchViewLayout, createWorkspaceLayout } from '../../../packages/core/src/spatial-layout'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { parseAgentMuxControlRequest } from '../../../packages/core/src/control-codec'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { createHostSpatialPresentation } from '../src/spatial-presentation'
import { MobileSpatialNavigation } from '../../mobile/src/navigation/MobileSpatialNavigation'
import { useMobileAttentionCatalog } from '../../mobile/src/navigation/use-mobile-attention-catalog'
import { executeSpatialControl } from '../../desktop/src/renderer/src/lib/space-agent-control'
import { readAgentPresentation } from '../../desktop/src/renderer/src/lib/mobile-presentation'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { mount, mounted, deferred } from '../../mobile/test/conversation-fixture'
import type { AgentMuxSpatialGraph } from '../../../packages/core/src/spatial-graph'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const wait = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => {}); assertion() }, { timeout: 15000 })
const facts = async (row: unknown) => { if (process.env.SPATIAL_STATUS_PROOF) await appendFile(join(process.env.SPATIAL_STATUS_PROOF, 'facts.ndjson'), JSON.stringify(row) + '\n') }
async function fixture(extra = 3) {
  const ids = ['selected', 'needs-you', ...Array.from({ length: extra }, (_, i) => 'unrelated-' + i)]
  const f = await rpcOwnerFixture(ids); cleanup.push(f.close)
  const original = await f.store.readMetadata('needs-you')
  const observedAt = Date.now()
  await f.store.compareAndSwap(original!, { ...original!, updatedAt: observedAt, semanticStatus: { state: 'blocked', source: 'native-hook', observedAt } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: 'selected', item: { id: 'selected-answer', agentSessionId: 'selected', kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original answer', content: 'ORIGINAL SELECTED ANSWER', createdAt: 1, updatedAt: 1 } })
  const configurationPath = join(f.root, 'configuration.json')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'work', hostId: 'local', path: f.root, name: 'Original project', kind: 'folder' }], executors: { codex: { providerId: 'codex', label: 'Original Codex' } }, appearance: {} }))
  const graph: AgentMuxSpatialGraph = { spaces: [{ spaceId: 'original-space', kind: 'folder', hostId: 'local', directoryPath: f.root, name: 'Original project', projectId: null }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'work', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: ids.map(id => ({ tabId: 'tab-' + id, zoneId: 'original-zone', workspaceId: 'work', name: id, regionIds: ['region-' + id] })),
    regions: ids.map(id => ({ tabId: 'tab-' + id, regionId: 'region-' + id, kind: 'agent', agentSessionId: id, runId: 'run-' + id, execution: { hostId: 'local', cwd: f.root } })),
    bindings: [{ spaceId: 'original-space', zoneId: 'original-zone' }], resources: {},
    layouts: { work: createWorkspaceLayout('original-group', ids.map(id => 'tab-' + id)) },
    tabLayouts: Object.fromEntries(ids.map(id => ['tab-' + id, createWorkbenchViewLayout('region-' + id)])) }
  const spatial = new AgentMuxSpatialStateStore(join(f.root, 'spatial.json')); await spatial.commit({ expectedRevision: 0, graph })
  const timeline = vi.spyOn(f.client, 'sessionTimeline'), metadata = vi.spyOn(f.client, 'readAgentSession'), status = vi.spyOn(f.client, 'statusAgent')
  const presentation = createHostSpatialPresentation({ configurationPath, clients: f.coreClients }), contexts: AbortSignal[] = []
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'status.sock'), coreClients: f.coreClients, spatialState: spatial,
    spatialPresentation: (input, context) => { if (context.signal) contexts.push(context.signal); return presentation(input, context) } })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  return { f, ids, rpc, server, timeline, metadata, status, contexts, spatial }
}

it.each([1, 12])('status RPC and original scoped full reading retain their distinct costs with %s unrelated Sessions', async extra => {
  const h = await fixture(extra)
  expect(rpcControlRequest('space.ls', { target: {}, presentation: 'status' })).toMatchObject({ presentation: 'status' })
  expect(parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'read-status', operation: 'space.ls', target: {}, presentation: 'status' })).toMatchObject({ presentation: 'status' })
  for (const presentation of ['yes', 'full', {}, 1]) expect(() => rpcControlRequest('space.ls', { target: {}, presentation })).toThrow()
  for (const params of [{ target: {} }, { target: {}, presentation: false }]) {
    expect((await h.rpc.call('space.ls', params)).catalog.agentPresentation).toBeUndefined()
  }
  expect(h.metadata).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled()
  const oldReceipt = h.rpc.call('space.inspect', { target: { operationId: 'original-unavailable-operation' }, presentation: 'status' })
  await oldReceipt.catch(() => {}) // Its original missing owner may reject; it must never trigger presentation.
  expect(h.metadata).not.toHaveBeenCalled(); expect(h.status).not.toHaveBeenCalled(); expect(h.timeline).not.toHaveBeenCalled()
  expect(() => rpcControlRequest('space.inspect', { target: { operationId: 'original-unavailable-operation' }, presentation: 'unknown' })).toThrow()
  const light = await h.rpc.call('space.ls', { target: {}, presentation: 'status' })
  expect(light.catalog.agentPresentation).toHaveLength(h.ids.length)
  expect(h.timeline, 'Status mode never reads timeline/history/recap').not.toHaveBeenCalled()
  expect(light.catalog.agentPresentation!.every(row => row.recap === null)).toBe(true)
  const full = await h.rpc.call('space.inspect', { target: { tabId: 'tab-selected' }, presentation: true })
  expect(full.catalog.agentPresentation).toMatchObject([{ agentSessionId: 'selected', recap: { text: 'ORIGINAL SELECTED ANSWER' } }])
  expect(h.timeline.mock.calls.map(([id]) => id), 'Unrelated Sessions never enlarge selected content history').toEqual(['selected'])
  await facts({ case: 'status-and-scoped-full', unrelated: extra, statusRows: light.catalog.agentPresentation!.length, statusTimeline: 0, fullTimelineIds: h.timeline.mock.calls.map(([id]) => id) })
})

it('status Survey composition reaches the original Renderer callback without reviving the cached full Focus history projection', async () => {
  const h = await fixture(1), source = await h.f.client.readAgentSession('selected')
  const timeline = await h.f.client.sessionTimeline('selected'); h.timeline.mockClear()
  const state: any = { config: { workspaces: [{ id: 'work', hostId: 'local', path: h.f.root, name: 'Original project', kind: 'folder' }], executors: {}, appearance: {} },
    sessions: [{ id: 'selected', kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: h.f.root, label: 'Original selected',
      capabilities: { timeline: 'streaming' }, createdAt: source!.createdAt, updatedAt: source!.updatedAt, agentSessionUpdatedAt: source!.updatedAt,
      latestOutputBytes: 0, processState: 'running', status: { state: 'done', source: 'native-hook', observedAt: 1 }, control: { kind: 'agent', agentSessionId: 'selected', hostId: 'local', run: source!.run } }],
    timelines: { selected: timeline }, agentNames: {}, scratchTopicSnapshots: {}, spaceObjectIcons: {}, tabs: {}, layouts: {}, spaceZoneBindings: {}, spatialRequests: {} }
  const projection = vi.fn(() => readAgentPresentation(state)), survey = { items: [], pages: [], selection: null, profileView: null }
  const service = new AgentMuxRpcService({ spatialState: h.spatial, callOriginalCore: (_host, method, params, context) => h.rpc.call(method, params, context?.signal ? { signal: context.signal } : {}),
    spatialPresentation: async ({ presentation = true }, context) => {
      const result = await executeSpatialControl({ get: () => state, topics: async () => [], agentPresentation: projection, surveyPresentation: () => survey } as never,
        { schemaVersion: 5, requestId: 'original-survey-read', operation: 'space.ls', target: {}, presentation }, context.signal)
      return { survey: result.operation === 'space.ls' ? result.catalog.survey : undefined }
    } })
  cleanup.push(() => service.dispose())
  const light = await service.call('space.ls', { target: {}, presentation: 'status' })
  expect(light.catalog.survey, JSON.stringify(light.presentation)).toEqual(survey)
  expect(projection, 'Status Survey must not recompute cached full conversation recap').not.toHaveBeenCalled()
  expect(h.timeline).not.toHaveBeenCalled()
  await service.call('space.ls', { target: {}, presentation: true })
  expect(projection).toHaveBeenCalledTimes(1); expect(projection.mock.results[0]!.value).toHaveLength(1)
  await facts({ case: 'desktop-survey-cached-projection', statusProjection: 0, fullProjection: projection.mock.calls.length, fullRows: projection.mock.results[0]!.value.length })
})

it('the real Source CLI discovers and transports both original presentation selections and rejects unknown or conflicting choices', async () => {
  const h = await fixture(2), env = objectCliEnvironment(h.f.root)
  if (process.env.SPATIAL_STATUS_CLI_LOADED) env.SPATIAL_STATUS_CLI_LOADED = process.env.SPATIAL_STATUS_CLI_LOADED
  const loader = process.env.SPATIAL_STATUS_CLI_LOADER ? new URL(process.env.SPATIAL_STATUS_CLI_LOADER) : undefined
  const call = (...args: string[]) => runSourceObjectCli(['--endpoint', 'unix:' + h.server.path, ...args], env, '', 30000, loader)
  const skill = await call('space', '--skill'), help = await call('space', 'ls', '--help')
  expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('--presentation-status'); expect(help.stdout).toContain('--presentation-status')
  const light = await call('space', 'ls', '--presentation-status'); expect(light.code, light.stderr).toBe(0)
  expect(JSON.parse(light.stdout).result.catalog.agentPresentation).toHaveLength(h.ids.length)
  expect(h.timeline, 'CLI status also has zero timeline work').not.toHaveBeenCalled()
  const full = await call('space', 'inspect', '--tab', 'tab-selected', '--presentation'); expect(full.code, full.stderr).toBe(0)
  expect(JSON.parse(full.stdout).result.catalog.agentPresentation).toMatchObject([{ recap: { text: 'ORIGINAL SELECTED ANSWER' } }])
  expect((await call('space', 'ls', '--presentation', '--presentation-status')).code).not.toBe(0)
  expect((await call('space', 'ls', '--presentation-status', 'unknown')).code).not.toBe(0)
  await facts({ case: 'source-cli', skill: skill.code, help: help.code, light: light.code, full: full.code, fullTimelineIds: h.timeline.mock.calls.map(([id]) => id) })
})

function Attention({ client, active = true }: { client: any; active?: boolean }) {
  const observation = useMobileAttentionCatalog(client, active, false)
  return <output data-confirmed={!observation.unconfirmed}>{observation.items.map(item => item.agentSessionId).join(',')}</output>
}
it('actual ordinary Mobile directory and hidden needs-you readers stay light while a real wide Focus rail remains full', async () => {
  const h = await fixture(5), calls: any[] = []
  if (process.env.SPATIAL_STATUS_CAPTURE_ENTRY && process.env.SPATIAL_STATUS_PROOF) {
    const input = join(process.env.SPATIAL_STATUS_PROOF, 'capture-input.json'); await writeFile(input, JSON.stringify({ socket: h.server.path }))
    const result = await new Promise<{code:number|null;stdout:string;stderr:string}>(done => {
      const cp = spawn(process.execPath, [process.env.SPATIAL_STATUS_CAPTURE_ENTRY!, '--label', 'status-and-full', '--input', input], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''; cp.stdout.on('data', v => stdout += v); cp.stderr.on('data', v => stderr += v); cp.on('exit', code => done({ code, stdout, stderr }))
    })
    await writeFile(join(process.env.SPATIAL_STATUS_PROOF, 'capture.stdout.log'), result.stdout); await writeFile(join(process.env.SPATIAL_STATUS_PROOF, 'capture.stderr.log'), result.stderr)
    expect(result.code, result.stderr).toBe(0); return
  }
  const focusTarget = document.createElement('div'); document.body.append(focusTarget); cleanup.push(() => focusTarget.remove())
  const client: any = { forwardRpc: (method: any, params: any, context: any) => { calls.push({ method, params, signal: context?.signal }); return h.rpc.call(method, params, context?.signal ? { signal: context.signal } : {}) }, onEvent: () => () => {} }
  const render = (focus: boolean) => <ClientUiProvider platform={createBrowserPlatform()}><MobileSpatialNavigation home="space" client={client} connected sessions={[]} focusVisible={focus} focusTarget={focusTarget} openSession={() => {}} /></ClientUiProvider>
  const view = await mount(render(false))
  await wait(() => expect(h.status.mock.calls.length).toBeGreaterThanOrEqual(h.ids.length))
  expect(h.timeline, 'Ordinary Mobile directory must not hydrate any history').not.toHaveBeenCalled()
  expect(calls.some(row => row.method === 'space.ls' && row.params.presentation === 'status')).toBe(true)
  expect(calls.every(row => row.signal instanceof AbortSignal)).toBe(true)
  await view.render(render(true))
  await wait(() => expect(focusTarget.textContent).toContain('ORIGINAL SELECTED ANSWER'))
  expect(calls.filter(row => row.method === 'space.ls').at(-1).params.presentation).toBe(true)
  const fullCount = h.timeline.mock.calls.length
  await view.render(render(false))
  await wait(() => expect(calls.filter(row => row.method === 'space.ls').at(-1).params.presentation).toBe('status'))
  await wait(() => expect(h.contexts.at(-1)?.aborted).toBe(false))
  await view.render(<Attention client={client} />)
  await wait(() => expect(view.element.querySelector('output')?.dataset.confirmed).toBe('true'))
  expect(view.element.textContent).toContain('needs-you')
  expect(h.timeline.mock.calls.length, 'Hidden needs-you must not hydrate history').toBe(fullCount)
  await facts({ case: 'mobile-directory-and-attention', ordinaryTimeline: 0, hiddenAttentionTimeline: 0, focusTimeline: fullCount, selections: calls.filter(row => row.method === 'space.ls').map(row => row.params.presentation), signals: calls.every(row => row.signal instanceof AbortSignal) })
})

it('cancelling the real public reader during original metadata starts no later status or timeline enrichment', async () => {
  const h = await fixture(1), hold = deferred<void>(), read = h.f.client.readAgentSession.bind(h.f.client)
  h.metadata.mockImplementationOnce(async id => { await hold.promise; return read(id) })
  const controller = new AbortController(), request = h.rpc.call('space.inspect', { target: { tabId: 'tab-selected' }, presentation: true }, { signal: controller.signal })
  void request.catch(() => {})
  await wait(() => expect(h.metadata).toHaveBeenCalled())
  controller.abort()
  await expect(request).rejects.toBeDefined()
  await wait(() => expect(h.contexts.at(-1)?.aborted).toBe(true))
  hold.resolve(); await new Promise(resolve => setTimeout(resolve, 50))
  expect(h.status, 'Cancelled metadata cannot begin later status work').not.toHaveBeenCalled()
  expect(h.timeline, 'Cancelled metadata cannot begin history work').not.toHaveBeenCalled()
  await facts({ case: 'public-cancelled-metadata', ownerSignalAborted: true, laterStatus: h.status.mock.calls.length, laterTimeline: h.timeline.mock.calls.length, lowerLevelReadKilled: false })
})
