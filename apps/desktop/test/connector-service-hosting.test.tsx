// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionHostingTarget } from '../src/shared/contracts'
import { ConnectorServiceControl } from '../src/renderer/src/components/settings/ConnectorServiceControl'
import { useMoteIdentityReadings } from '../src/renderer/src/components/settings/MoteIdentityCards'
import { api } from '../src/renderer/src/lib/api'
import { readConnectorService, selectConnectorServiceObservation } from '../src/renderer/src/lib/connector-service-observation'
import { restoredConnectorServiceIntents } from '../src/renderer/src/lib/connector-service-intent'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { retainConnectorServiceIntent, useAppStore } from '../src/renderer/src/store'
import { moteBotUi } from './fixtures/mote-bot-ui'
import { moteConnectionOwner } from './fixtures/mote-connection-owner'
import { createClientUiRoot } from './helpers/client-ui-render'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
afterAll(async () => { if (process.env.SERVICE_HOSTING_FACTS) await writeFile(process.env.SERVICE_HOSTING_FACTS, JSON.stringify({ scope: 'Mounted original Renderer/AppStore, trusted IPC and public Core/SQLite on two original controlled transports; not RuntimeController, live platform or installed GUI.', facts }, null, 2) + '\n') })
async function fixture() {
  const f = await moteBotUi({ generic: true }); cleanup.push(f.close)
  const root = await mkdtemp(join(tmpdir(), 'amx-service-owner-')), b = await moteConnectionOwner(root, { generic: true })
  cleanup.push(async () => { await b.close(); await rm(root, { recursive: true, force: true }) })
  const retainedAtDispatch: unknown[] = []
  const targetB = { hostId: 'other-host', runtimeId: 'other-runtime' }, calls: Array<{ target: ConnectionHostingTarget; method: string; input: any }> = []
  let selected = f.hostingTarget, loseReply = false, holdMethod = '', started = false, release!: () => void
  let held = Promise.resolve()
  vi.spyOn(f.runtime, 'connectionHostingTarget').mockImplementation(async () => structuredClone(selected))
  vi.spyOn(f.runtime, 'callConnectionHost').mockImplementation(async (target, method, input) => {
    calls.push({ target: structuredClone(target), method, input: structuredClone(input) })
    const client = JSON.stringify(target) === JSON.stringify(f.hostingTarget) ? f.client : JSON.stringify(target) === JSON.stringify(targetB) ? b.client : null
    if (!client) throw Error('The original controlled transport does not own this target')
    if (method === 'connection.service.configure') {
      const retained = useAppStore.getState().connectorServiceIntents[(input as { operationId: string }).operationId]
      retainedAtDispatch.push(structuredClone({ target, retained }))
    }
    const result = await client.call(method, input)
    if (method === 'connection.service.configure' && loseReply) { loseReply = false; throw Error('Original service ACK unavailable') }
    if (method === holdMethod && target.hostId === f.hostingTarget.hostId) { started = true; await held }
    return result
  })
  useAppStore.setState({ connectorServiceObservation: {}, connectorServiceIntents: {}, scratchTopicSnapshots: {
    [f.workspace.id]: { scope: scratchTopicsScope(f.workspace), revision: 0, topics: f.scopes.map(scope => scope.topic), error: null, reading: false }
  } })
  return { ...f, b, targetB, calls, retainedAtDispatch, selectB() { selected = targetB }, loseReply() { loseReply = true },
    hold(method: string) { holdMethod = method; held = new Promise(resolve => { release = resolve }) }, started: () => started, release: () => { holdMethod = ''; release() } }
}
async function mount(element: React.ReactNode) {
  const node = document.createElement('div'); document.body.append(node)
  const root = createClientUiRoot(node)
  cleanup.push(async () => { await act(async () => root.unmount()); node.remove() })
  await act(async () => root.render(element))
  return { node, render: async (next: React.ReactNode) => { await act(async () => root.render(next)) } }
}
const waitFor = async (assert: () => void) => await vi.waitFor(async () => { await act(async () => {}); assert() })
const status = (node: HTMLElement) => node.querySelector<HTMLElement>('[data-connector-service-state]')?.dataset.connectorServiceState
async function click(node: HTMLElement, selector: string) { await act(async () => node.querySelector<HTMLElement>(selector)!.click()) }

it('binds service configuration and lost ACK lookup to the retained original hosting target', async () => {
  const f = await fixture(), view = await mount(<ConnectorServiceControl active hostingTarget={f.hostingTarget} />)
  await waitFor(() => expect(status(view.node)).toBe('off'))
  f.selectB(); f.loseReply()
  await click(view.node, '[aria-label="Enable external chat sync"]'); await click(view.node, '[data-connector-service-save]')
  await waitFor(() => expect(view.node.textContent).toContain('save reply is unconfirmed'))
  const [intent] = Object.values(useAppStore.getState().connectorServiceIntents)
  expect(intent?.hostingTarget).toEqual(f.hostingTarget)
  expect((await f.client.call('connection.service.get', {})).enabled).toBe(true)
  expect((await f.b.client.call('connection.service.get', {})).enabled).toBe(false)
  expect(f.retainedAtDispatch).toEqual([{ target: f.hostingTarget, retained: intent }])
  await act(async () => useAppStore.persist.rehydrate())
  expect(useAppStore.getState().connectorServiceIntents[intent!.input.operationId]).toEqual(intent)
  await click(view.node, `[aria-label="Check original service request ${intent!.input.operationId}"]`)
  await waitFor(() => expect(view.node.textContent).toContain('Original request confirmed: On'))
  expect(f.calls.filter(call => call.method === 'connection.service.inspect').map(call => call.target)).toEqual([f.hostingTarget])
  expect(f.calls.filter(call => call.method === 'connection.service.configure')).toHaveLength(1)
  await expect(retainConnectorServiceIntent({ ...intent!, hostingTarget: f.targetB })).rejects.toThrow('cannot be replaced')
  facts.push({ case: 'original-service-ACK', intent, routes: f.calls, originalOn: true, otherOn: false, configureCount: 1 })
})

it('keeps concurrent service snapshots separate and ignores a late previous owner read', async () => {
  const f = await fixture(), before = await f.b.client.call('connection.service.get', {})
  await f.b.client.call('connection.service.configure', { operationId: 'other-owner-on', expectedRevision: before.revision, service: { enabled: true } })
  f.hold('connection.service.get')
  const view = await mount(<ConnectorServiceControl active hostingTarget={f.hostingTarget} />)
  await waitFor(() => expect(f.started()).toBe(true))
  await view.render(<ConnectorServiceControl active hostingTarget={f.targetB} />)
  await waitFor(() => expect(status(view.node)).toBe('on'))
  f.release(); await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  expect(status(view.node)).toBe('on')
  await act(async () => readConnectorService(() => true, f.hostingTarget))
  const projections = useAppStore.getState().connectorServiceObservation
  expect(selectConnectorServiceObservation(projections, f.hostingTarget)?.state?.enabled).toBe(false)
  expect(selectConnectorServiceObservation(projections, f.targetB)?.state?.enabled).toBe(true)
  expect(selectConnectorServiceObservation(projections)).toBeNull()
  expect(f.calls.filter(call => call.method === 'connection.service.configure')).toHaveLength(0)
  facts.push({ case: 'service-scope-late-read', original: f.hostingTarget, other: f.targetB, originalEnabled: false, otherEnabled: true, defaultSnapshot: null })
})

it('retains ownerless service requests without querying or adopting the default hosting target', async () => {
  const f = await fixture(), input = { operationId: 'old-unconfirmed-service', expectedRevision: 1, service: { enabled: true } }
  const old = { input, phase: 'may-have-dispatched' as const }
  expect(restoredConnectorServiceIntents({ [input.operationId]: old })[input.operationId]).toEqual(old)
  await retainConnectorServiceIntent(old)
  const view = await mount(<ConnectorServiceControl active hostingTarget={null} />)
  const check = view.node.querySelector<HTMLButtonElement>(`[aria-label="Check original service request ${input.operationId}"]`)
  expect(check).not.toBeNull(); expect(check!.disabled).toBe(true)
  expect(view.node.textContent).toContain('original hosting target is not recorded')
  expect(f.calls).toEqual([])
  await act(async () => useAppStore.persist.rehydrate())
  expect(useAppStore.getState().connectorServiceIntents[input.operationId]).toEqual(old)
  await expect(retainConnectorServiceIntent({ ...old, hostingTarget: f.hostingTarget })).rejects.toThrow('cannot be replaced')
  expect(useAppStore.getState().connectorServiceIntents[input.operationId]).toEqual(old)
  expect(f.calls).toEqual([])
  facts.push({ case: 'ownerless-service-retained', old, queries: 0, effects: 0 })
})

it('binds Mote preferences and chat reads to one hosting target and isolates a late old owner result', async () => {
  const f = await fixture()
  const target = f.target(), results: Array<ReturnType<typeof useMoteIdentityReadings>> = []
  function Probe({ owner }: { owner?: ConnectionHostingTarget | null }) {
    const readings = useMoteIdentityReadings(true, 0, owner); results.push(readings)
    const reading = readings.items.find(item => item.target?.spaceId === target.spaceId)
    return <output data-profile-status={reading?.saved?.status ?? 'none'} data-chat-read={String(reading?.chatRead ?? false)}>{reading?.issue}</output>
  }
  f.selectB() // Resource/Workspace location cannot select the hosting owner.
  const view = await mount(<Probe owner={f.hostingTarget} />)
  await waitFor(() => expect(view.node.querySelector('output')?.getAttribute('data-profile-status')).toBe('ready'))
  expect(f.calls.filter(call => call.method === 'space.mote.preferences.read' || call.method === 'space.mote.chat.inspect').every(call => JSON.stringify(call.target) === JSON.stringify(f.hostingTarget))).toBe(true)
  await view.render(<Probe owner={null} />)
  await waitFor(() => expect(view.node.textContent).toContain('hosting target is not confirmed'))
  const blockedCount = f.calls.length; await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  expect(f.calls).toHaveLength(blockedCount)
  f.hold('space.mote.preferences.read')
  await view.render(<Probe owner={f.hostingTarget} />)
  await waitFor(() => expect(f.started()).toBe(true))
  await view.render(<Probe owner={f.targetB} />)
  f.release(); await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  await waitFor(() => expect(view.node.querySelector('output')?.getAttribute('data-profile-status')).toBe('unconfirmed'))
  facts.push({ case: 'mote-read-owner-and-lifetime', original: f.hostingTarget, other: f.targetB, routes: f.calls, finalOriginalResourceOnForeignOwner: 'unconfirmed', nullOwnerCalls: 0 })
})
