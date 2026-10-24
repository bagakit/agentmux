// @vitest-environment happy-dom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import type { CapsuleMethod, CapsuleParamsMap, CapsulePort } from '@agentmux/core/capsule'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { CapsuleRunManager } from '../../../packages/core/src/capsule-run-manager'
import { AgentMuxError, type AgentMuxControlFailure } from '../../../packages/core/src/errors'
import { callCapsuleFromApp } from '../src/main/capsule-ipc'
import { sessionInputOperationResult, unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { api } from '../src/renderer/src/lib/api'
import { CapsuleSettingsPane } from '../src/renderer/src/components/settings/CapsuleSettingsPane'
import { UserToolkitResult } from '../src/renderer/src/components/toolkit/UserToolkitResult'
import { SettingsNavigation } from '../src/renderer/src/components/SettingsNavigation'
import { createClientUiRoot } from './helpers/client-ui-render'
import type { ToolkitScriptSnapshot, ToolkitToolDefinition } from '@agentmux/core/control'

let directory: string, owner: NodeCapsuleOwner, manager: CapsuleRunManager, server: AgentMuxControlServer
let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>, capsuleId: string, sourcePath: string
let route: CapsulePort['call'], normal: CapsulePort['call'], container: HTMLDivElement, root: Root
let flights: Set<Promise<unknown>>, calls: Array<{ method: CapsuleMethod; params: CapsuleParamsMap[CapsuleMethod] }>
let nativeCalls: string[], snapshot: ToolkitScriptSnapshot
const contexts = ['settings', 'toolkit'] as const
type Consumer = typeof contexts[number]
const mutation = (consumer: Consumer) => consumer === 'settings' ? 'capsule.config.update' : 'capsule.open'

function track<T>(promise: Promise<T>): Promise<T> {
  flights.add(promise)
  void promise.then(() => flights.delete(promise), () => flights.delete(promise))
  return promise
}
async function settle() { while (flights.size) await act(async () => { await Promise.allSettled([...flights]) }) }
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
  expect(found, 'Connected action: ' + text).toBeDefined(); return found!
}
async function click(text: string) { await act(async () => button(text).click()); await settle() }
const action = (consumer: Consumer) => consumer === 'settings' ? 'Save defaults' : 'Open page'
const check = (consumer: Consumer) => consumer === 'settings' ? 'Check original operation' : 'Check original open'
const writes = (consumer: Consumer) => calls.filter(call => call.method === mutation(consumer))
function input() { return container.querySelector<HTMLInputElement>('[aria-label="New Capsule content root"]')! }
async function edit(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true })); input().dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function mount(consumer: Consumer) {
  await act(async () => root.render(consumer === 'settings' ? <CapsuleSettingsPane /> :
    <SettingsNavigation.Provider value={{ open() {}, openToolkit() {}, openHost() {}, openChannel() {}, channelEntries: [], channelPresentation: () => null, openMoteLark() {}, chooseAgent() {} }}>
      <UserToolkitResult definition={snapshot.definition} active close={() => {}} />
    </SettingsNavigation.Provider>))
  await settle()
  if (consumer === 'settings') await edit(join(directory, 'edited-root'))
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'capsule-predispatch-')); sourcePath = join(directory, 'source')
  await mkdir(sourcePath); await writeFile(join(sourcePath, 'index.html'), '<title>Retained page</title>')
  owner = await NodeCapsuleOwner.open({ stateDirectory: join(directory, 'domain'), presentation: {
    open: async (params, _context, resolved) => ({ ...params, endpoint: resolved.endpoint,
      rendering: { status: 'available', browserId: 'unexecuted-browser', tabId: 'unexecuted-tab', regionId: 'unexecuted-region' } })
  } })
  capsuleId = (await owner.call('capsule.create', { operationId: 'retained-page', sourcePath })).record.capsuleId
  nativeCalls = []
  manager = new CapsuleRunManager(new Proxy({} as import('@agentmux/core').AgentMuxClient, { get(_object, key) { return () => {
    nativeCalls.push(String(key)); throw new Error('This private fixture never calls Native')
  } } }), join(directory, 'manager'))
  await mkdir(join(directory, 'manager'))
  await writeFile(join(directory, 'manager/capsule-service.json'), JSON.stringify({ schema: 'agentmux.capsule-service.v1', revision: 1,
    desired: 'stopped', stateDirectory: manager.stateDirectory, socketPath: manager.socketPath, runtimeId: null,
    run: null, launch: null, launchPhase: null, stop: null, stopPhase: null, command: null }))
  normal = ((method, params, context) => owner.call(method, params, context)) as CapsulePort['call']; route = normal
  server = new AgentMuxControlServer({ coreClients: () => [], capsules: { call: (method, params, context) => route(method, params, context) } }, join(directory, 'c.sock'))
  await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  flights = new Set(); calls = []
  vi.spyOn(api.capsules, 'call').mockImplementation(((method: CapsuleMethod, params: CapsuleParamsMap[CapsuleMethod]) => {
    calls.push({ method, params: structuredClone(params) })
    return track(sessionInputOperationResult(() => callCapsuleFromApp((_host, rpcMethod, rpcParams) => rpc.call(rpcMethod, rpcParams), method, params))
      .then(value => unwrapSessionInputOperationResult(structuredClone(value))))
  }) as CapsulePort['call'])
  // Initial runtime projection is controlled, as when a form outlives a later external Stop.
  vi.spyOn(api.capsuleRuntime, 'call').mockResolvedValue({ revision: 1, desired: 'running', phase: 'running', stateDirectory: join(directory, 'domain'),
    socketPath: join(directory, 'unused-runtime.sock'), run: null, runtime: null, operation: null, issue: null })
  vi.spyOn(api.ui, 'chooseDirectory').mockResolvedValue(null); vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const definition: ToolkitToolDefinition = { id: 'original-page-tool', revision: 'original-definition', name: 'Page generator', icon: 'terminal', enabled: true,
    statusBar: 'icon', workspacePath: sourcePath, script: 'generate()', args: [], actions: [] }
  snapshot = { schema: 'agentmux.toolkit.v1', kind: 'script', toolId: definition.id, definition, state: 'succeeded', reason: null, admission: null,
    consumerCount: 1, sequence: 1, latestConfirmed: { executionId: 'original-execution', invocationId: 'original-invocation', definition,
      expectedLatestExecutionId: null, target: { workspacePath: sourcePath }, run: { hostId: 'local', runId: 'unexecuted-tool-run' },
      startedAt: 1, endedAt: 2, text: '', state: 'succeeded', reason: null, exitCode: 0,
      document: { schema: 'agentmux.toolkit.result.v1', summary: 'Saved report', items: [], links: [], notice: '', capsules: [{ capsuleId, label: 'Saved report' }] } } }
  vi.spyOn(api.toolkit, 'observe').mockImplementation((_id, read) => { read(snapshot); return { dispose() {} } })
  vi.spyOn(api.toolkit, 'get').mockResolvedValue(snapshot)
  vi.spyOn(api.toolkit, 'run'); vi.spyOn(api.toolkit, 'action')
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); await settle(); container.remove()
  await rpc.dispose(); await server.stop(); await manager.dispose(); await owner.close()
  await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it.each(contexts)('%s permits a fresh explicit action after real manager refusal through public RPC and the App envelope', async consumer => {
  await mount(consumer)
  const editor = consumer === 'settings' ? input() : null
  route = ((method, params, context) => manager.call(method, params, context)) as CapsulePort['call']
  await click(action(consumer))
  const failed = writes(consumer)[0]!, failure = await vi.mocked(api.capsules.call).mock.results[calls.indexOf(failed)]!.value.catch(error => error)
  expect(failure.code).toBe('CAPSULE_RUNTIME_STOPPED')
  expect(failure.controlFailure).toEqual({ disposition: 'not_applied', confirmedInputBytes: 0 })
  expect(container.textContent).toContain(failed.params.operationId)
  expect(button(action(consumer)).disabled, 'Exact pre-dispatch nonapplication must release only the failed attempt').toBe(false)
  expect((await owner.call('capsule.operation.inspect', { operationId: failed.params.operationId })).operation).toBeNull()
  route = normal // Controlled transport recovery; no Native service restart is claimed.
  if (consumer === 'settings') {
    await click('Read current defaults')
    expect(input()).toBe(editor); expect(input().value).toBe(join(directory, 'edited-root'))
  }
  await click(action(consumer))
  const next = writes(consumer)[1]!
  expect(next.params.operationId).not.toBe(failed.params.operationId)
  expect((await owner.call('capsule.operation.inspect', { operationId: next.params.operationId })).operation?.status).toBe('committed')
  expect(nativeCalls).toEqual([]); expect(api.toolkit.run).not.toHaveBeenCalled(); expect(api.toolkit.action).not.toHaveBeenCalled()
})

it.each(contexts)('%s keeps a post-effect lost receipt inspect-only and consumes the same committed original operation', async consumer => {
  await mount(consumer)
  let lost = false
  route = (async (method, params, context) => {
    const value = await normal(method, params, context)
    if (method === mutation(consumer) && !lost) { lost = true; throw new AgentMuxError('Original result was lost after its effect', 'CONTROL_UNAVAILABLE', undefined,
      { disposition: 'unknown', confirmedInputBytes: null }) }
    return value
  }) as CapsulePort['call']
  await click(action(consumer))
  const original = writes(consumer)[0]!
  expect(button(action(consumer)).disabled, 'An unknown postdispatch attempt must remain inspect-only').toBe(true)
  expect(container.textContent).toContain(original.params.operationId)
  await click(action(consumer)); expect(writes(consumer)).toHaveLength(1)
  await click(check(consumer))
  expect(calls.filter(call => call.method === 'capsule.operation.inspect').at(-1)!.params).toEqual({ operationId: original.params.operationId })
  expect((await owner.call('capsule.operation.inspect', { operationId: original.params.operationId })).operation?.status).toBe('committed')
  expect(writes(consumer)).toHaveLength(1); expect(nativeCalls).toEqual([])
})

it.each(contexts)('%s never interprets absent, unknown, null-byte or prefix receipts as permission for a new action', async consumer => {
  const receipts: Array<AgentMuxControlFailure | undefined> = [undefined, { disposition: 'unknown', confirmedInputBytes: 0 },
    { disposition: 'not_applied', confirmedInputBytes: null }, { disposition: 'not_applied', confirmedInputBytes: 1 }]
  for (const controlFailure of receipts) {
    await mount(consumer)
    route = (async (method, params, context) => {
      if (method === mutation(consumer)) throw new AgentMuxError('The operation was not applied; retry', 'CAPSULE_RUNTIME_STOPPED', undefined, controlFailure)
      return normal(method, params, context)
    }) as CapsulePort['call']
    const before = writes(consumer).length
    await click(action(consumer))
    expect(button(action(consumer)).disabled, 'Only exact not_applied with zero confirmed bytes permits a fresh action').toBe(true)
    await click(check(consumer))
    expect(writes(consumer)).toHaveLength(before + 1)
    await act(async () => root.render(null)); await settle(); route = normal
  }
  expect(nativeCalls).toEqual([])
})
