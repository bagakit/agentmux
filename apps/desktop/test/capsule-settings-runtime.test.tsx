// @vitest-environment happy-dom
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc, type CapsuleRuntimePort } from '@agentmux/core'
import type { startHeadlessAgentMux } from '@agentmux/core/headless-runtime'
import { staleDistComplaint } from '../../../vitest.dist-freshness'
import { callCapsuleFromApp } from '../src/main/capsule-ipc'
import { CapsuleSettingsPane } from '../src/renderer/src/components/settings/CapsuleSettingsPane'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot } from './helpers/client-ui-render'
import { toolkitRuntime } from './helpers/toolkit-runtime.fixture'

vi.mock('electron', () => ({ app: { getPath: () => process.cwd(), getAppPath: () => process.cwd() } }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('starts and stops the exact independent service through App management while retaining drafts and an unknown original command', async () => {
  for (const name of ['core', 'capsule']) expect(await staleDistComplaint(resolve('packages', name))).toBeNull()
  // Node loads the fresh published owner. Browser asset transforms must not
  // reinterpret Core's qualified Native artifact URLs inside the DOM fixture.
  const builtCore = createRequire(import.meta.url)(resolve('packages/core/dist/index.js')) as typeof import('@agentmux/core')
  const builtHeadless = createRequire(import.meta.url)(resolve('packages/core/dist/headless-runtime.js')) as typeof import('@agentmux/core/headless-runtime')
  const native = await toolkitRuntime(), directory = native.directory
  for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') || key.startsWith('CTXMUX_')) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', directory); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson')); vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(directory, 'sessions.json'))
  vi.stubEnv('PATH', dirname(process.execPath) + ':' + process.env.PATH)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let core: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, root: Root | undefined, container: HTMLDivElement | undefined
  try {
    core = await builtHeadless.startHeadlessAgentMux({ stateDirectory: join(directory, 'state'), socketPath: join(directory, 'control.sock'),
      store: new builtCore.AgentMuxFileAgentSessionStore(join(directory, 'sessions.json')), providers: [] })
    await core.client.connect()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: core.socketPath } })
    const flights = new Set<Promise<unknown>>(), calls: Array<{ method: string; params: any }> = []
    const track = <T,>(promise: Promise<T>) => { flights.add(promise); void promise.then(() => flights.delete(promise), () => flights.delete(promise)); return promise }
    const original = <M extends import('@agentmux/core').AgentMuxRpcMethod>(_hostId: string, method: M, params: import('@agentmux/core').AgentMuxRpcParams<M>) => rpc!.call(method, params)
    let loseStart = false, foreignInspect = false
    const runtimeCall: CapsuleRuntimePort['call'] = async (method, params) => {
      calls.push({ method, params: structuredClone(params) })
      // The native sender is controlled; the actual Main adapter and Unix/Core owner are consumed.
      const value = await callCapsuleFromApp(original, method, params) as Awaited<ReturnType<CapsuleRuntimePort['call']>>
      if (method === 'capsule.runtime.start' && loseStart) { loseStart = false; throw new Error('Original Start reply lost after dispatch') }
      if (method === 'capsule.runtime.inspect' && foreignInspect) { foreignInspect = false; return { ...value, operation: { operationId: 'another-original-operation', kind: 'start', phase: 'confirmed' } } }
      return value
    }
    vi.spyOn(api.capsuleRuntime, 'call').mockImplementation(((method, params) => track(runtimeCall(method, params))) as CapsuleRuntimePort['call'])
    vi.spyOn(api.capsules, 'call').mockImplementation(((method, params) => track(callCapsuleFromApp(original, method, params))) as typeof api.capsules.call)
    container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
    const settle = async () => { while (flights.size) await act(async () => { await Promise.allSettled([...flights]) }) }
    const button = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)
    const click = async (label: string) => { expect(button(label), label).toBeDefined(); await act(async () => button(label)!.click()); await settle() }
    const rootField = () => container!.querySelector<HTMLInputElement>('[aria-label="New Capsule content root"]')!
    await act(async () => root!.render(<CapsuleSettingsPane />)); await settle()
    expect(container.textContent, 'Settings entry must remain an observation').toContain('Not started')
    expect(await native.activation.client.list(), 'Settings entry must remain an observation').toEqual([])
    expect(api.capsules.call, 'Settings entry must remain an observation').not.toHaveBeenCalled()
    await click('Start service')
    await vi.waitFor(async () => expect((await rpc!.call('capsule.runtime.inspect', {})).phase).toBe('running'), { timeout: 10000 })
    if (button('Check original service command')) await click('Check original service command')
    else await click('Read service status')
    const initial = await rpc.call('capsule.runtime.inspect', {})
    expect(initial.phase).toBe('running'); expect(initial.run).not.toBeNull()
    const sourcePath = join(directory, 'content'); await mkdir(sourcePath); await writeFile(join(sourcePath, 'index.html'), '<!doctype html><title>Retained page</title>Retained original content')
    const page = await rpc.call('capsule.create', { operationId: 'settings-original-page', sourcePath, title: 'Retained page' })
    await click('Refresh pages')
    expect(container.textContent).toContain(initial.run!.runId)
    const savedRoot = rootField().value, draft = join(directory, 'unsaved-root')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(rootField(), draft)
      rootField().dispatchEvent(new Event('input', { bubbles: true })); rootField().dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Stop service')
    await vi.waitFor(async () => expect((await rpc!.call('capsule.runtime.inspect', {})).phase, 'Stop must bind the exact observed service Run').toBe('stopped'), { timeout: 10000 })
    if (button('Check original service command')) await click('Check original service command')
    else await click('Read service status')
    const stop = calls.find(value => value.method === 'capsule.runtime.stop')!
    expect(stop.params).toMatchObject({ expectedRevision: initial.revision, expectedRun: { runId: initial.run!.runId } })
    expect(container.textContent).toContain('Stopped')
    expect(rootField(), 'Stopped service must retain mounted dirty defaults').not.toBeNull()
    expect(rootField().value).toBe(draft)
    expect(container.textContent).toContain('Retained page')
    await click('Read current defaults')
    expect(container.textContent).toContain('explicitly stopped'); expect(rootField().value).toBe(draft)

    loseStart = true
    await click('Start service')
    const start = calls.filter(value => value.method === 'capsule.runtime.start').at(-1)!
    expect(container.textContent).toContain(start.params.operationId)
    expect(button('Start service')?.disabled).toBe(true)
    await vi.waitFor(async () => expect((await rpc!.call('capsule.runtime.inspect', {})).phase).toBe('running'), { timeout: 10000 })
    foreignInspect = true
    await click('Check original service command')
    expect(button('Check original service command'), 'Unrelated operation cannot confirm the original service command').toBeDefined()
    expect(container.textContent).toContain('still unconfirmed')
    await click('Check original service command')
    expect(container.textContent).toContain('The original service Start is confirmed.')
    expect(calls.filter(value => value.method === 'capsule.runtime.start' && value.params.operationId === start.params.operationId)).toHaveLength(1)
    expect(rootField().value).toBe(draft); expect(container.textContent).toContain('Retained page')
    expect((await rpc.call('capsule.config.inspect', {})).config.contentRoot).toBe(savedRoot)
    const restored = await rpc.call('capsule.inspect', { capsuleId: page.record.capsuleId })
    expect(restored.record).toMatchObject({ capsuleId: page.record.capsuleId, contentRoot: page.record.contentRoot })
    const service = await rpc.call('capsule.runtime.inspect', {})
    expect(service.runtime?.runtimeId).toBe(initial.runtime?.runtimeId); expect(service.run).not.toEqual(initial.run)
    expect(JSON.parse(await readFile(join(directory, 'state', 'capsule-service.json'), 'utf8'))).toMatchObject({ desired: 'running', run: { runId: service.run!.runId } })
    await expect(callCapsuleFromApp(original, 'capsule.runtime.remove', {})).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await expect(callCapsuleFromApp(original, 'capsule.runtime.stop', { operationId: 'malformed-stop', expectedRevision: service.revision })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  } finally {
    if (root) await act(async () => root!.unmount()); container?.remove()
    await rpc?.dispose(); await core?.stop()
    for (const run of await native.activation.client.list()) {
      if (run.state.type === 'running') await native.activation.client.stop(await native.activation.client.prepareStop(run.id))
      await native.activation.client.remove(run.id)
    }
    expect(await native.activation.client.list()).toEqual([])
    const cleanup = await native.cleanup(); expect(cleanup.childExit).toBe('confirmed'); expect(cleanup.namespace).toBe('removed')
  }
}, 45000)
