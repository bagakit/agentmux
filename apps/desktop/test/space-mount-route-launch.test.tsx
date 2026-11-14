// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { createHostRouteInventoryFixture } from '../../../packages/core/test/helpers/host-route-inventory-fixture'
import { api } from '../src/renderer/src/lib/api'
import * as storeModule from '../src/renderer/src/store'
import { useAppStore } from '../src/renderer/src/store'
import { MountedSpaceLauncher } from '../src/renderer/src/components/MountedSpaceLauncher'
import { mountedAgentOpenInput, mountedAgentOpenKey } from '../src/renderer/src/lib/space-mount-launch'
import { spaceMountKey, type SpaceMountMethods, type SpaceMountRecord } from '../src/shared/space-mount'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

/** Actual four-Core signed route and inventory owners plus registered trusted Main,
 * original Preload module and Renderer. Only B project metadata and final creation
 * are controlled leaves; this test makes no Native/creation-effect claim. */
async function fixture(pending?: { firstOpen: Promise<void>; secondOpen: Promise<void> }) {
  const inspection = { report: null as SpaceMountMethods['open']['result'] | null, wait: undefined as Promise<void> | undefined, openOutcome: 'unknown' as SpaceMountMethods['open']['result']['outcome'] }
  const settled: string[] = [], readsSettled: string[] = []
  const route = await createHostRouteInventoryFixture(cleanup as Array<() => Promise<void>>), opens: SpaceMountMethods['open']['input']['request'][] = [], reads: string[] = []
  const target: SpaceMountRecord = { hostId: 'source-B', reference: { runtimeId: route.b.identity.runtimeId, spaceId: 'original-B-space' }, workspaceId: 'original-B-project', zoneId: 'original-B-zone' }
  const carrier = {
    forwardRpc: async (method: string, params: unknown, context: unknown) => {
      reads.push(method)
      if (method === 'runtime.owner.identity') return { owner: { runtimeId: target.reference.runtimeId, ownerInstanceId: 'original-B-instance', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' } }
      if (method === 'settings.hosts.ls') return { hosts: [{ id: 'local', kind: 'local', label: 'Project device' }, { id: 'collision', kind: 'ssh', hostname: 'private-configured-edge.example', label: 'Direct C device', runtimeId: route.c.identity.runtimeId }] }
      if (method === 'settings.executors.discover') {
        const selected = params as { hostId: string; refresh: boolean }
        expect(selected.refresh).toBe(false)
        if (selected.hostId === 'local') return { runtimeId: target.reference.runtimeId, routeHostId: 'local', executors: [] }
        if (selected.hostId === 'collision') return { routeHostId: selected.hostId, ...await route.collision.client.listHostExecutors({ refresh: false }) }
        throw Error('Unknown exact direct Host')
      }
      if (method === 'agent.open') {
        const request = params as SpaceMountMethods['open']['input']['request']; opens.push(request)
        const wait = opens.length === 1 ? pending?.firstOpen : opens.length === 2 ? pending?.secondOpen : undefined
        if (wait) await wait
        return { operationId: request.operationId, outcome: inspection.openOutcome, from: null, to: null, agent: null, resource: null,
          save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: null }, issues: [] }
      }
      if (method === 'space.inspect') { if (inspection.wait) await inspection.wait; return { request: { known: inspection.report !== null, requestId: (params as { target: { requestId: string } }).target.requestId, report: inspection.report } } }
      return await route.rpc.call(method as never, params as never, context as never)
    }, subscribeRpc: route.rpc.subscribe.bind(route.rpc)
  }
  const transport = spaceMountTransport(cleanup, [{ id: target.hostId, carrier: carrier as never }])
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    try { return await transport.api.call(method, input, signal) }
    finally {
      if (method === 'open') { const operationId = (input as SpaceMountMethods['open']['input']).request.operationId; expect(operationId).toBeTypeOf('string'); settled.push(operationId!) }
      if (method === 'inspect') readsSettled.push((input as SpaceMountMethods['inspect']['input']).requestId)
    }
  })
  vi.spyOn(storeModule, 'checkpointMountedSpaceInputs').mockImplementation(async () => {
    const retained = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, key)
    expect(retained?.submitted).toBe(true)
  })
  useAppStore.setState({ mountedSpaceInputs: {}, mountedSpaceObservations: {} }); useAppStore.getState().mountSpace(target)
  const slot = { kind: 'new-work' as const, zoneId: target.zoneId }, key = mountedAgentOpenKey(target, slot)
  const project = { zoneId: target.zoneId, workspaceId: target.workspaceId, kind: 'home' as const, hostId: 'local', directoryPath: '/original/B/project', branch: null }
  await dom.render(<MountedSpaceLauncher target={target} project={project} slot={slot} mountKey={spaceMountKey(target.reference)} active />)
  const device = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent device"]')!
  await vi.waitFor(async () => { await act(async () => {}); expect(Array.from(device.options).some(option => option.textContent?.includes('2 hops'))).toBe(true) })
  const routeOption = Array.from(device.options).find(option => option.textContent?.includes('2 hops'))!, directOption = Array.from(device.options).find(option => option.textContent?.includes('Direct C device'))!
  expect(routeOption.value).not.toBe(directOption.value)
  await act(async () => { device.value = routeOption.value; device.dispatchEvent(new Event('change', { bubbles: true })) })
  const executor = dom.container.querySelector<HTMLSelectElement>('[aria-label="Original Space Agent configuration"]')!
  await vi.waitFor(async () => { await act(async () => {}); expect(executor.textContent).toContain('runtime-D original') })
  return { route, target, slot, key, device, executor, opens, reads, inspection, settled, readsSettled }
}

test('the mounted Launcher selects D through the original B route without a same-name direct Host substitution or per-option probes', async () => {
  const f = await fixture()
  expect(f.route.inventory).toHaveBeenCalledTimes(1); expect(f.route.creation).not.toHaveBeenCalled(); expect(f.route.native).not.toHaveBeenCalled()
  await act(async () => { f.executor.value = 'same-executor'; f.executor.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(dom.container.textContent).toContain('/private/runtime-D/original-command')
  const prompt = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="New mounted Space task draft"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'Original B project task'); prompt.dispatchEvent(new Event('input', { bubbles: true })) })
  expect(f.route.inventory).toHaveBeenCalledTimes(1)
  const start = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!
  expect(start.disabled).toBe(false)
  await act(async () => { start.click() }); await vi.waitFor(() => expect(f.opens).toHaveLength(1))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
  expect(original.request).toEqual(f.opens[0])
  expect(original.request).toMatchObject({ content: { executorId: 'same-executor', prompt: 'Original B project task',
    agentTarget: { hostId: 'collision', runtimeId: 'runtime-D', adoptedRoute: f.route.route } }, destination: { spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, newTab: true } })
  const check = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Check original task')!
  await act(async () => { check.click() }); await vi.waitFor(() => expect(f.reads).toContain('space.inspect'))
  expect(f.opens).toHaveLength(1)
  const local = Array.from(f.device.options).find(option => option.textContent === 'Project device · original Core')!
  await act(async () => { f.device.value = local.value; f.device.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(f.device.selectedOptions[0]!.textContent).toBe('Project device · original Core')
  const next = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Continue original task')!
  await act(async () => { next.click() }); await vi.waitFor(() => expect(f.opens).toHaveLength(2))
  expect(f.opens[1]).toEqual(original.request)
  expect(f.route.inventory).toHaveBeenCalledTimes(1); expect(f.route.original.rawInput).not.toHaveBeenCalled()
})

test('a lost receiving-node grant preserves the route selection and project draft without probing the same-name direct Host', async () => {
  const f = await fixture(); await f.route.configure(f.route.d, [], [])
  const refresh = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Refresh devices')!
  await act(async () => { refresh.click() })
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.textContent).toContain('not delegated') })
  expect(dom.container.textContent).toContain('/original/B/project')
  expect(f.device.selectedOptions[0]!.textContent).toContain('2 hops')
  expect(f.opens).toEqual([]); expect(f.route.creation).not.toHaveBeenCalled(); expect(f.route.original.rawInput).not.toHaveBeenCalled()
})

test('a failed continuation checkpoint cannot turn an already submitted original request into an unsent task', async () => {
  const f = await fixture()
  await act(async () => { f.executor.value = 'same-executor'; f.executor.dispatchEvent(new Event('change', { bubbles: true })) })
  const start = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!
  await act(async () => { start.click() }); await vi.waitFor(() => expect(f.opens).toHaveLength(1))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
  vi.mocked(storeModule.checkpointMountedSpaceInputs).mockRejectedValueOnce(Error('The original private checkpoint is unavailable.'))
  const next = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Continue original task')!
  await act(async () => { next.click() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The original task was not continued.'))
  expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)).toMatchObject({ submitted: true, request: original.request })
  expect(f.opens).toHaveLength(1)
  expect(Array.from(dom.container.querySelectorAll('button')).some(button => button.textContent === 'Send original task')).toBe(false)
})


test('checking an opened original request updates the available recovery actions without replacing its earlier unknown receipt', async () => {
  const f = await fixture()
  await act(async () => { f.executor.value = 'same-executor'; f.executor.dispatchEvent(new Event('change', { bubbles: true })) })
  const start = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Start in original Space')!
  await act(async () => { start.click() }); await vi.waitFor(() => expect(f.opens).toHaveLength(1))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
  f.inspection.report = { ...original.receipt!, outcome: 'opened' }
  const check = Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Check original task')!
  await act(async () => { check.click() })
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original Space confirmed the new Agent.'))
  expect(Array.from(dom.container.querySelectorAll('button')).some(button => button.textContent === 'Continue original task')).toBe(false)
  expect(Array.from(dom.container.querySelectorAll('button')).some(button => button.textContent === 'Prepare another task')).toBe(true)
  expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)?.receipt?.outcome).toBe('unknown')
  expect(f.opens).toHaveLength(1); expect(f.route.original.rawInput).not.toHaveBeenCalled()
})


test('a confirmed earlier task cannot keep the next original task busy or leak its late failure into it', async () => {
  let rejectFirst!: (cause: Error) => void, releaseSecond!: () => void
  const firstOpen = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
  const secondOpen = new Promise<void>(resolve => { releaseSecond = resolve })
  const f = await fixture({ firstOpen, secondOpen })
  let rejected = false
  try {
    await act(async () => { f.executor.value = 'same-executor'; f.executor.dispatchEvent(new Event('change', { bubbles: true })) })
    const button = (label: string) => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!
    await act(async () => { button('Start in original Space').click() })
    await vi.waitFor(() => expect(f.opens).toHaveLength(1))
    const earlier = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
    f.inspection.report = { operationId: earlier.request.operationId, outcome: 'opened', from: null, to: null, agent: null, resource: null,
      save: { layoutApplied: false, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: null }, issues: [] }
    await act(async () => { button('Check original task').click() })
    await vi.waitFor(() => expect(dom.container.textContent).toContain('Original Space confirmed the new Agent.'))
    expect(f.settled).not.toContain(earlier.request.operationId)
    await act(async () => { button('Prepare another task').click() })
    expect(button('Start in original Space').disabled).toBe(false)
    await act(async () => { button('Start in original Space').click() })
    await vi.waitFor(() => expect(f.opens).toHaveLength(2))
    const current = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
    expect(current.request.operationId).not.toBe(earlier.request.operationId)
    expect(button('Continue original task').disabled).toBe(true)
    await act(async () => { rejected = true; rejectFirst(Error('Earlier task transport reply ended late.')) })
    await vi.waitFor(() => expect(f.settled).toContain(earlier.request.operationId))
    await act(async () => {})
    expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)?.request).toEqual(current.request)
    expect(button('Continue original task').disabled).toBe(true)
    expect(dom.container.textContent).not.toContain('Earlier task transport reply ended late.')
    expect(f.opens.map(request => request.operationId)).toEqual([earlier.request.operationId, current.request.operationId])
  } finally {
    await act(async () => { if (!rejected) rejectFirst(Error('Private fixture cleanup')); releaseSecond() })
  }
})


test('a rejected earlier Check cannot replace the issue of a different original task', async () => {
  const f = await fixture()
  let rejectRead!: (cause: Error) => void, rejected = false
  try {
    const button = (label: string) => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!
    await act(async () => { f.executor.value = 'same-executor'; f.executor.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { button('Start in original Space').click() })
    await vi.waitFor(() => expect(f.settled).toHaveLength(1))
    const earlier = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
    f.inspection.report = { ...earlier.receipt!, outcome: 'opened' }
    await act(async () => { button('Check original task').click() })
    await vi.waitFor(() => expect(button('Prepare another task')).toBeDefined())
    f.inspection.wait = new Promise<void>((_resolve, reject) => { rejectRead = reject })
    await act(async () => { button('Check original task').click() })
    await vi.waitFor(() => expect(f.reads.filter(method => method === 'space.inspect')).toHaveLength(2))
    expect(f.readsSettled).toHaveLength(1)
    await act(async () => { button('Prepare another task').click() })
    await act(async () => { button('Start in original Space').click() })
    await vi.waitFor(() => expect(f.settled).toHaveLength(2))
    const current = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
    expect(current.request.operationId).not.toBe(earlier.request.operationId)
    await act(async () => { rejected = true; rejectRead(Error('Earlier Check transport ended late.')) })
    await vi.waitFor(() => expect(f.readsSettled).toHaveLength(2))
    await act(async () => {})
    expect(dom.container.textContent).not.toContain('Earlier Check transport ended late.')
    expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)?.request).toEqual(current.request)
    expect(f.opens.map(request => request.operationId)).toEqual([earlier.request.operationId, current.request.operationId])
  } finally { if (rejectRead && !rejected) await act(async () => { rejectRead(Error('Private fixture read cleanup')) }) }
})

test.each(['receipt', 'inspection'] as const)('a retired original Agent from %s keeps its original receipt and offers a new task without continuation', async source => {
  const f = await fixture(), button = (label: string) => Array.from(dom.container.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)
  if (source === 'receipt') f.inspection.openOutcome = 'retired'
  await act(async () => { f.executor.value = 'same-executor'; f.executor.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => { button('Start in original Space')!.click() })
  await vi.waitFor(() => expect(f.settled).toHaveLength(1))
  const original = mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)!
  if (source === 'inspection') {
    f.inspection.report = { ...original.receipt!, outcome: 'retired' }
    await act(async () => { button('Check original task')!.click() })
    await vi.waitFor(() => expect(f.readsSettled).toHaveLength(1))
  }
  await act(async () => {})
  expect(dom.container.textContent).toContain('Original Agent was retired.')
  expect(dom.container.textContent).not.toContain('Original Space confirmed the new Agent.')
  expect(button('Continue original task')).toBeUndefined()
  expect(button('Prepare another task')).toBeDefined()
  expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)?.receipt).toEqual(original.receipt)
  expect(f.opens).toHaveLength(1)
  await act(async () => { button('Prepare another task')!.click() })
  expect(mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, f.key)).toBeUndefined()
  expect(button('Start in original Space')?.disabled).toBe(false)
  expect(f.opens).toHaveLength(1)
  expect(f.route.original.rawInput).not.toHaveBeenCalled()
})
