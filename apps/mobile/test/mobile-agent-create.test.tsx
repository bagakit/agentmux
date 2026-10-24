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
import { createWorkbenchTab } from '../../desktop/src/renderer/src/lib/workbench-tabs'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { button, click, deferred, mount, mounted } from './conversation-fixture'
import { fixturePath } from '../../../test/fixture-values.mjs'

beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => { for (const item of mounted.splice(0)) { await act(async () => item.root.unmount()); item.element.remove() }; document.body.replaceChildren(); vi.restoreAllMocks() })
function setup(options: { launcher?: boolean; requireRetainedIntent?: boolean } = {}) {
  const creations = new Map<string, unknown>()
  let state = { config: { workspaces: [{ id: 'original-workspace', hostId: 'local', path: fixturePath('original'), name: 'Original Project', kind: 'folder' }], hosts: [{ id: 'local', name: 'Local', kind: 'local' }], executors: { original: { name: 'Original Executor', hostId: 'local', providerId: 'codex' } } }, sessions: [], tabs: {}, layouts: { 'original-workspace': createWorkspaceLayout('original-group', []) }, spaceZoneBindings: {}, spatialRequests: {} } as any
  if (options.launcher) {
    const tab = createWorkbenchTab('original-tab', { kind: 'launcher', regionId: 'original-region', workspaceId: 'original-workspace' }, 'Original empty workface')
    state.tabs = { [tab.id]: tab }; state.layouts['original-workspace'] = createWorkspaceLayout('original-group', [tab.id])
  }
  const launch = vi.fn(async input => {
    if (options.requireRetainedIntent !== false) expect(getDeviceWorkface().snapshot().record.agentCreates?.some(item => item.input.operationId === input.createOperationId)).toBe(true)
    const session = { id: input.agentSessionId, kind: 'agent', providerId: 'codex', executorId: 'original', hostId: 'local', workspacePath: input.workspacePath, label: 'Original Agent', processState: 'running', capabilities: {}, status: { state: 'running', source: 'run-process', observedAt: 1 }, control: { kind: 'agent', agentSessionId: input.agentSessionId, hostId: 'local', run: { runId: 'created-run' } } } as any
    state.sessions.push(session)
    const created = { ...agentCreationFixture(session), creation: { createOperationId: input.createOperationId, initialPrompt: 'not-requested' } }
    creations.set(session.id, created)
    return { created, session, creation: created.creation, timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [] }
  })
  const ports = { get: () => state, patch: (patch: any) => { state = { ...state, ...patch } }, topics: async () => [],
    launch, creation: async (_host: string, id: string) => creations.get(id) ?? null,
    createResource: async () => { throw new Error('No new resource requested') }, attach: async () => {},
    save: async (layoutApplied: boolean) => ({ layoutApplied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null }),
    focus: vi.fn(), isFocused: () => false, notice: vi.fn(), closing: () => false }
  const execute = async (request: any) => request.operation === 'settings.resource.list' ? { operation: request.operation, resource: 'executors', items: [{ id: 'original', value: state.config.executors.original }], partial: true }
    : await executeSpatialControl(ports as any, request as any) as any
  const service = new AgentMuxRpcService({ execute })
  const rpc = vi.fn((method: string, params: any) => service.call(method as any, params))
  const client = { forwardRpc: rpc, runtimeOwnerIdentity: () => ({ runtimeId: 'original-runtime' }), onEvent: () => () => {} } as any
  const catalog = spatialCatalog(state, [])
  const target = { spaceId: catalog.spaces[0]!.spaceId, zoneId: catalog.zones[0]!.zoneId, tabId: 'original-tab', regionId: 'original-region' }
  return { client, rpc, catalog, launch, execute, target, state: () => state, occupy: () => {
    state = { ...state, tabs: { ...state.tabs, 'original-tab': createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: 'original-workspace', path: 'kept.note.md' }, 'Occupied workface') } }
  }, remove: () => { state = { ...state, tabs: {} } }, unbind: () => {
    state = { ...state, spaceZoneBindings: { [target.zoneId]: { spaceId: target.spaceId, workspaceId: 'original-workspace', relations: { [target.spaceId]: false } } } }
  }, open: vi.fn(), props: { client, connected: true, visible: true, target: {}, platform: createBrowserPlatform(), onClose: vi.fn(), openSession: vi.fn() } }
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
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.agentSessionId).toBeTruthy()) })
  expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('unknown')
  expect(document.body.textContent).toContain('工作面持久化尚未确认')
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

it('keeps another healthy Host creation independent of a pending original request and reconciles each original operation', async () => {
  const f = setup(), next = setup(), held = deferred<void>(), source = f.client.forwardRpc
  next.client.runtimeOwnerIdentity = () => ({ runtimeId: 'next-runtime' })
  f.client.forwardRpc = async (method: string, params: any) => {
    const result = await source(method, params)
    if (method === 'agent.open') await held.promise
    return result
  }
  const view = await mount(<MobileAgentCreate {...f.props} />); await choose(f)
  await click(button(document.body, '创建 Agent'))
  await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(1))
  const first = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(first.phase).toBe('sending')
  await view.render(<MobileAgentCreate {...next.props} />); await choose(next)
  expect(button(document.body, '创建 Agent').disabled).toBe(false)
  await click(button(document.body, '创建 Agent'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('confirmed')) })
  const second = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(second.input.operationId).not.toBe(first.input.operationId)
  expect(second.runtimeId).toBe('next-runtime'); expect(next.launch).toHaveBeenCalledTimes(1)
  await act(async () => { held.reject(new Error('Original A receipt lost')); await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.find(item => item.input.operationId === first.input.operationId)?.phase).toBe('unknown')) })
  expect(document.body.textContent).not.toContain('Original A receipt lost')
  await view.render(<MobileAgentCreate {...f.props} />)
  await click(button(document.body, '核对原创建操作'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.find(item => item.input.operationId === first.input.operationId)?.agentSessionId).toBeTruthy()) })
  expect(getDeviceWorkface().snapshot().record.agentCreates?.find(item => item.input.operationId === first.input.operationId)?.phase).toBe('unknown')
  expect(document.body.textContent).toContain('工作面持久化尚未确认')
  expect(f.rpc).toHaveBeenCalledWith('space.inspect', { target: { operationId: first.input.operationId } })
  expect(f.launch).toHaveBeenCalledTimes(1); expect(next.launch).toHaveBeenCalledTimes(1)
  expect(getDeviceWorkface().snapshot().record.agentCreates).toHaveLength(2)
})

it('creates only at the selected original Launcher through the public codec and creator', async () => {
  const f = setup({ launcher: true })
  await mount(<MobileAgentCreate {...f.props} target={f.target} />)
  expect(f.launch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Original empty workface')
  expect(document.body.textContent).toContain('关闭表单不会创建')
  expect(document.querySelector<HTMLSelectElement>('[aria-label="新 Agent 空间"]')?.disabled).toBe(true)
  expect(document.querySelector<HTMLSelectElement>('[aria-label="新 Agent Zone"]')?.disabled).toBe(true)
  expect(document.querySelector('[aria-label="新 Agent Zone"]')?.textContent).not.toContain(fixturePath('original'))
  await select('新 Agent 执行器', 'original')
  await click(button(document.body, '创建 Agent'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('confirmed')) })
  const intent = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(intent.input.destination).toEqual(f.target)
  expect(f.rpc).toHaveBeenCalledWith('agent.open', intent.input)
  expect(Object.keys(f.state().tabs)).toEqual(['original-tab'])
  expect(f.state().tabs['original-tab'].regions['original-region']).toMatchObject({ kind: 'agent', sessionId: intent.agentSessionId })
  expect(f.launch).toHaveBeenCalledTimes(1)
})

it.each(['occupy', 'remove', 'unbind'] as const)('does not reroute or launch when the original Launcher changes: %s', async change => {
  const f = setup({ launcher: true })
  await mount(<MobileAgentCreate {...f.props} target={f.target} />)
  await select('新 Agent 执行器', 'original')
  f[change]()
  const original = structuredClone(f.state().tabs)
  await click(button(document.body, '创建 Agent'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('unknown')) })
  expect(f.launch).not.toHaveBeenCalled()
  expect(f.state().tabs).toEqual(original)
  const intent = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(intent.input.destination).toEqual(f.target)
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentCreates!.at(-1)!.input).toEqual(intent.input)
  await click(button(document.body, '核对原创建操作'))
  expect(f.rpc).toHaveBeenCalledWith('space.inspect', { target: { operationId: intent.input.operationId } })
  expect(f.launch).not.toHaveBeenCalled()
})

it('isolates old target receipts while another explicit target on the same healthy Host can create', async () => {
  const f = setup({ launcher: true }), held = deferred<void>(), source = f.client.forwardRpc
  f.client.forwardRpc = async (method: string, params: any) => {
    const result = await source(method, params)
    if (method === 'agent.open' && params.destination.regionId === f.target.regionId) await held.promise
    return result
  }
  const view = await mount(<MobileAgentCreate {...f.props} target={f.target} />)
  await select('新 Agent 执行器', 'original'); await click(button(document.body, '创建 Agent'))
  await vi.waitFor(() => expect(f.launch).toHaveBeenCalledTimes(1))
  const first = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  await view.render(<MobileAgentCreate {...f.props} target={{ spaceId: f.target.spaceId, zoneId: f.target.zoneId }} />)
  expect(button(document.body, '另建 Agent（保留待核对项）').disabled).toBe(false)
  await click(button(document.body, '另建 Agent（保留待核对项）'))
  await act(async () => { await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.at(-1)?.phase).toBe('confirmed')) })
  expect(f.launch).toHaveBeenCalledTimes(2)
  const second = getDeviceWorkface().snapshot().record.agentCreates!.at(-1)!
  expect(second.input.destination).toEqual({ spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true })
  await act(async () => { held.reject(new Error('Old Launcher receipt lost')); await vi.waitFor(() => expect(getDeviceWorkface().snapshot().record.agentCreates?.find(item => item.input.operationId === first.input.operationId)?.phase).toBe('unknown')) })
  expect(document.body.textContent).not.toContain('Old Launcher receipt lost')
  expect(document.body.textContent).toContain('Agent 已创建')
  expect(getDeviceWorkface().snapshot().record.agentCreates).toHaveLength(2)
})

it('decodes only complete new-Tab or exact-Launcher intents and preserves both original requests across reload', async () => {
  const f = setup({ launcher: true }), owner = getDeviceWorkface()
  const original = { runtimeId: 'original-runtime', deviceHostId: null, input: { operationId: 'original-new-tab', content: { kind: 'new-agent', executorId: 'original', prompt: 'Original draft' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false }, phase: 'unknown' }
  const exact = { ...original, input: { ...original.input, operationId: 'original-launcher', destination: f.target } }
  for (const intent of [original, exact]) await owner.retainAgentCreate(parseMobileAgentCreateIntent(intent), owner.recordIdentity())
  const before = new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentCreates
  expect(before).toEqual([original, exact])
  for (const destination of [
    { spaceId: f.target.spaceId, zoneId: f.target.zoneId },
    { spaceId: f.target.spaceId, zoneId: f.target.zoneId, tabId: f.target.tabId },
    { spaceId: f.target.spaceId, zoneId: f.target.zoneId, regionId: f.target.regionId },
    { ...f.target, zoneId: undefined }, { ...f.target, tabId: '' },
    { ...f.target, newTab: true }, { ...original.input.destination, tabId: undefined },
    { ...f.target, newTab: false }, { ...f.target, split: 'right' }
  ]) expect(() => parseMobileAgentCreateIntent({ ...original, input: { ...original.input, destination } })).toThrow('原 Agent 创建意图无效')
  expect(new DeviceWorkfaceStore(() => localStorage).snapshot().record.agentCreates).toEqual(before)
})

it('the executable agent-open CLI consumes the same original Launcher creator and inspects unknown and occupied operations', async () => {
  const f = setup({ launcher: true, requireRetainedIntent: false }), root = await mkdtemp(join(tmpdir(), 'mobile-create-'))
  // Keep the Node executable out of Vite's browser URL asset transform.
  const cliRelative = '../../../packages/core/bin/amux'
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AGENTMUX_TEST_OBJECT_CLI ?? fileURLToPath(new URL(cliRelative, import.meta.url)))
  let loseOriginalReceipt = true
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
    const result = await f.execute(request)
    if (request.operation === 'agent.open' && loseOriginalReceipt) { loseOriginalReceipt = false; throw new Error('Original creation receipt lost after commit') }
    return result
  } })
  await server.start()
  try {
    const call = async (args: string[], code = 0) => {
      const result = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...args], objectCliEnvironment(root))
      expect(result.code, result.stderr).toBe(code)
      return JSON.parse(result.stdout).result
    }
    const exact = ['agent', 'open', '--executor', 'original', '--space', f.target.spaceId, '--zone', f.target.zoneId, '--tab', f.target.tabId, '--region', f.target.regionId]
    const unknown = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...exact, '--operation-id', 'cli-original-launcher'], objectCliEnvironment(root))
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('Original creation receipt lost after commit')
    expect(f.launch).toHaveBeenCalledTimes(1)
    expect(Object.keys(f.state().tabs)).toEqual(['original-tab'])
    const original = structuredClone(f.state().tabs)
    // Inspection of an uncertain response reads the original operation; it never creates again.
    const inspected = await call(['space', 'inspect', '--operation-id', 'cli-original-launcher'])
    expect(inspected.request).toMatchObject({ operationId: 'cli-original-launcher', known: true, report: { operationId: 'cli-original-launcher', outcome: 'opened', to: f.target, agent: { executorId: 'original', createOperationId: 'cli-original-launcher' } } })
    const missing = await call(['space', 'inspect', '--operation-id', 'cli-unobserved-operation'], 1)
    expect(missing.request).toMatchObject({ operationId: 'cli-unobserved-operation', known: false, report: null })
    const occupied = await call([...exact, '--operation-id', 'cli-occupied-launcher'], 1)
    expect(occupied.outcome).toBe('unknown')
    expect(occupied.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SPACE_REGION_OCCUPIED' })]))
    expect(f.launch).toHaveBeenCalledTimes(1)
    expect(f.state().tabs).toEqual(original)
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() }
}, 45000)
