import { parseMobileAgentCreateIntent } from '../src/recovery/agent-create-intents'
import './mobile-lan-crypto.setup'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MobileAgentCreate } from '../src/navigation/MobileAgentCreate'
import { MobileSpatialNavigation } from '../src/navigation/MobileSpatialNavigation'
import { MobileZoneWorkface } from '../src/navigation/MobileZoneWorkface'
import { createBrowserPlatform } from '../src/platform/browser'
import { DeviceWorkfaceStore, emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { executeSpatialControl, spatialCatalog } from '../../desktop/src/renderer/src/lib/space-agent-control'
import { agentCreationFixture } from '../../desktop/test/helpers/agent-creation-fixture'
import { createWorkspaceLayout } from '../../../packages/layout/src/index'
import { button, click, deferred, mount, mounted } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
function setup() {
  let state = { config: { workspaces: [{ id: 'original-workspace', hostId: 'local', path: fixturePath('original'), name: 'Original Project', kind: 'folder' }], hosts: [{ id: 'local', name: 'Local', kind: 'local' }], executors: { original: { name: 'Original Executor', hostId: 'local', providerId: 'codex' } } }, sessions: [], tabs: {}, layouts: { 'original-workspace': createWorkspaceLayout('original-group', []) }, spaceZoneBindings: {}, spatialRequests: {} } as any
  const launch = vi.fn(async input => {
    expect(getDeviceWorkface().snapshot().record.agentCreates?.some(item => item.input.operationId === input.createOperationId)).toBe(true)
    const session = { id: input.agentSessionId, kind: 'agent', providerId: 'codex', executorId: 'original', hostId: 'local', workspacePath: input.workspacePath, label: 'Original Agent', processState: 'running', capabilities: {}, status: { state: 'running', source: 'run-process', observedAt: 1 }, control: { kind: 'agent', agentSessionId: input.agentSessionId, hostId: 'local', run: { runId: 'created-run' } } } as any
    state.sessions.push(session)
    const created = { ...agentCreationFixture(session), creation: { createOperationId: input.createOperationId, initialPrompt: 'not-requested' } }
    return { created, session, creation: created.creation, timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [] }
  })
  const ports = { get: () => state, patch: (patch: any) => { state = { ...state, ...patch } }, topics: async () => [],
    launch, creation: async (_host: string, id: string) => agentCreationFixture(state.sessions.find((item: any) => item.id === id)),
    createResource: async () => { throw new Error('No new resource requested') }, attach: async () => {},
    save: async (layoutApplied: boolean) => ({ layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }),
    focus: vi.fn(), isFocused: () => false, notice: vi.fn(), closing: () => false }
  const service = new AgentMuxRpcService({ execute: async request => request.operation === 'settings.resource.list' ? { operation: request.operation, resource: 'executors', items: [{ id: 'original', value: state.config.executors.original }], partial: true }
    : await executeSpatialControl(ports as any, request as any) as any })
  const rpc = vi.fn((method: string, params: any) => service.call(method as any, params))
  const client = { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }), onEvent: () => () => {} } as any
  const catalog = spatialCatalog(state, [])
  return { client, rpc, catalog, launch, open: vi.fn(), props: { client, connected: true, visible: true, target: {}, platform: createBrowserPlatform(), onClose: vi.fn(), openSession: vi.fn() } }
}
async function select(label: string, value: string) {
  const input = document.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function choose(f: ReturnType<typeof setup>) {
  await select('新 Agent 空间', f.catalog.spaces[0]!.spaceId)
  await select('新 Agent Zone', f.catalog.zones[0]!.zoneId)
  await select('新 Agent 执行器', 'original')
}
it('connects Focus/Mote/Space and Topic entry points without creating an Agent during reading', async () => {
  const f = setup(), create = vi.fn()
  for (const home of ['focus', 'mote', 'space'] as const) {
    const view = await mount(<MobileSpatialNavigation {...f.props} home={home} sessions={[]} openSession={f.open} onCreateAgent={create} />)
    await click(button(view.element, '新建 Agent'))
  }
  const topic = await mount(<MobileZoneWorkface client={f.client} zoneId={f.catalog.zones[0]!.zoneId} name="Original Topic" visible openSession={f.open} onCreateAgent={create} />)
  await click(button(topic.element, '在此 Topic 新建 Agent'))
  expect(create).toHaveBeenLastCalledWith({ zoneId: f.catalog.zones[0]!.zoneId })
  expect(f.launch).not.toHaveBeenCalled()
})
it('executes the original public codec and spatial creation owner only after exact selections, retaining intent before launch', async () => {
  const f = setup()
  await mount(<MobileAgentCreate {...f.props} />)
  await click(button(document.body, '创建 Agent')); expect(f.launch).not.toHaveBeenCalled()
  await choose(f)
  await click(button(document.body, '创建 Agent'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('confirmed')) })
  expect(f.launch, document.body.textContent ?? undefined).toHaveBeenCalledTimes(1)
  const intent = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(intent.phase).toBe('confirmed')
  expect(f.launch.mock.calls[0]![0]).toMatchObject({ createOperationId: intent.input.operationId, workspacePath: fixturePath('original'), executorId: 'original' })
  expect(intent.input.destination).toEqual({ spaceId: f.catalog.spaces[0]!.spaceId, zoneId: f.catalog.zones[0]!.zoneId, newTab: true })
  expect(f.props.openSession).not.toHaveBeenCalled()
  await click(button(document.body, '打开原 Agent 对话'))
  expect(f.props.openSession).toHaveBeenCalledWith(intent.agentSessionId)
})
it('keeps a lost creation receipt across reload and inspects the original operation without a second launch', async () => {
  const f = setup(), source = f.client.forwardRpc
  f.client.forwardRpc = async (method: string, params: any) => { const result = await source(method, params); if (method === 'agent.open') throw new Error('Original response lost'); return result }
  const view = await mount(<MobileAgentCreate {...f.props} />); await choose(f)
  await click(button(document.body, '创建 Agent'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('unknown')) })
  const intent = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(intent.phase).toBe('unknown'); expect(f.launch).toHaveBeenCalledTimes(1)
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentCreates!.at(-1)!.input).toEqual(intent.input)
  await view.render(<MobileAgentCreate {...f.props} visible={false} />); await view.render(<MobileAgentCreate {...f.props} />)
  expect(f.launch).toHaveBeenCalledTimes(1)
  await click(button(document.body, '核对原创建操作'))
  expect(f.launch).toHaveBeenCalledTimes(1)
  expect(f.rpc).toHaveBeenCalledWith('space.inspect', { target: { operationId: intent.input.operationId } })
})

it('uses the existing complete device budget for a long initial instruction', async () => {
  const f = setup(), owner = getDeviceWorkface()
  const input = { runtimeId: 'original-runtime', deviceHostId: null, input: { operationId: 'long-original-input', content: { kind: 'new-agent', executorId: 'original', prompt: '保留原始证据。'.repeat(20000) }, destination: { spaceId: f.catalog.spaces[0]!.spaceId, zoneId: f.catalog.zones[0]!.zoneId, newTab: true }, focus: false }, phase: 'sending' }
  await owner.retainAgentCreate(parseMobileAgentCreateIntent(input), owner.recordIdentity())
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentCreates?.at(-1)?.input.content.prompt).toBe(input.input.content.prompt)
})

it('does not qualify a new Host with a previous client discovery while its exact catalog is pending', async () => {
  const f = setup(), next = setup(), spaces = deferred<any>(), executors = deferred<any>()
  const view = await mount(<MobileAgentCreate {...f.props} />); await choose(f)
  next.client.forwardRpc = vi.fn((method: string) => method === 'space.ls' ? spaces.promise : executors.promise)
  await view.render(<MobileAgentCreate {...next.props} />)
  expect(document.querySelector('[aria-label="新 Agent 执行器"]')?.textContent).not.toContain('Original Executor')
  await click(button(document.body, '创建 Agent'))
  expect(next.client.forwardRpc).not.toHaveBeenCalledWith('agent.open', expect.anything())
  expect(getDeviceWorkface().snapshot().record.agentCreates ?? []).toHaveLength(0)
  await act(async () => { spaces.resolve({ catalog: next.catalog }); executors.resolve({ items: [{ id: 'original', value: { name: 'New Host Executor' } }] }); await spaces.promise; await executors.promise })
  expect(document.querySelector('[aria-label="新 Agent 执行器"]')?.textContent).toContain('New Host Executor')
})
