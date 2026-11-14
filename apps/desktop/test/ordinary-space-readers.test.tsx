// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SpaceSourceReaders, useSpaceSourceReader } from '../src/renderer/src/components/SpaceSourceReaders'
import { useFocusSources } from '../src/renderer/src/lib/use-focus-sources'
import { spaceMountKey } from '../src/shared/space-mount'
import type { SpaceMountRecord } from '../src/shared/space-mount'
import { createRendererSessionEvents } from '../src/renderer/src/lib/session-events'

const cleanup: Array<() => unknown | Promise<unknown>> = []
let root: Root | undefined
const before = useAppStore.getState()
afterEach(async () => {
  await act(async () => root?.unmount()); root = undefined
  for (const close of cleanup.splice(0).reverse()) await close()
  useAppStore.setState(before, true); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function VisibleConsumer({ target, visible, label }: { target: SpaceMountRecord; visible: boolean; label: string }) {
  const refresh = useSpaceSourceReader(target, visible)
  return visible ? <button onClick={refresh}>{label}</button> : null
}
function FocusReaders({ visible }: { visible: boolean }) { return useFocusSources({ visible, contexts: [], onCloseOriginal: () => {} }).readers }
it('ordinary source readers share the existing real Main/Core scope and only the last visible consumer releases it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await createSpaceSessionsFixture(cleanup)
  const main = spaceMountTransport(cleanup, [{ id: 'original-B', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }])
  const metadata = vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  const business = vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  const target = { hostId: 'original-B', reference: f.reference, zoneId: 'original-zone', workspaceId: 'original-b-project' }
  useAppStore.setState({ mountedSpaceInputs: { [spaceMountKey(target.reference)]: { target: { ...target, reference: { spaceId: target.reference.spaceId, runtimeId: target.reference.runtimeId } }, drafts: {} } } })
  const state = useAppStore.getState()
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  const view = (first: boolean, second: boolean, mounted = false) => <SpaceSourceReaders>
    <FocusReaders visible={mounted} />
    <VisibleConsumer target={target} visible={first} label="First Region" />
    <VisibleConsumer target={target} visible={second} label="Second Region" />
  </SpaceSourceReaders>
  await act(async () => root!.render(view(true, true, true)))
  await vi.waitFor(() => { expect(metadata).toHaveBeenCalledOnce(); expect(business).toHaveBeenCalledOnce() })
  await act(async () => root!.render(view(false, true)))
  expect(metadata).toHaveBeenCalledOnce(); expect(business).toHaveBeenCalledOnce()
  expect(metadata.mock.calls[0]![2]!.aborted).toBe(false)
  await act(async () => [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Second Region')!.click())
  await vi.waitFor(() => { expect(metadata).toHaveBeenCalledTimes(2); expect(business).toHaveBeenCalledTimes(2) })
  expect(metadata.mock.calls[0]![2]!.aborted).toBe(true)
  expect(metadata.mock.calls[1]![2]!.aborted).toBe(false)
  await act(async () => root!.render(view(false, false)))
  expect(metadata.mock.calls[1]![2]!.aborted).toBe(true)
  expect(business.mock.calls[1]![2]!.aborted).toBe(true)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(state.mountedSpaceInputs)
  expect(useAppStore.getState().sessions).toBe(state.sessions)
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
})

/** Actual Core→Unix→Main/IPC/preload readers; only Host transport loss/recovery
 * is controlled here, independently of any displayed Agent status. */
async function recoveryFixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const f = await createSpaceSessionsFixture(cleanup)
  const main = spaceMountTransport(cleanup, [{ id: 'original-B', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }])
  const listeners = new Set<Parameters<typeof api.sessions.onEvent>[0]>()
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(createRendererSessionEvents(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }))
  const emit = async (hostId = 'original-B', restored = false) => act(async () => {
    const evidence = { source: 'agentmux' as const, observedAt: Date.now() }
    for (const listener of listeners) listener({ type: 'core', hostId, event: restored
      ? { type: 'connection-state', state: 'restored', evidence }
      : { type: 'session-observation-state', observation: { state: 'ready', hasSnapshot: true }, evidence } })
  })
  const watch = vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  const sessions = vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  const target = { hostId: 'original-B', reference: f.reference, zoneId: 'original-zone', workspaceId: 'original-b-project' }
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node)
  const render = (visible = true) => act(async () => root!.render(<SpaceSourceReaders>
    <VisibleConsumer target={target} visible={visible} label="First Region" />
    <VisibleConsumer target={target} visible={visible} label="Second Region" />
  </SpaceSourceReaders>))
  const key = spaceMountKey(target.reference)
  useAppStore.setState({ mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {}, agentComposerDrafts: { original: 'Keep my unsent work' } })
  const effects = (['createAgent', 'resumeAgent', 'restartAgent', 'stopAgent', 'submitAgentPrompt'] as const).map(method => vi.spyOn(f.b.core, method))
  const assertPreserved = () => {
    expect(useAppStore.getState().agentComposerDrafts.original).toBe('Keep my unsent work')
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  }
  return { f, main, watch, sessions, target, key, render, emit, listeners, assertPreserved }
}

it.each([false, true])('failed shared source observations rejoin their exact recovered Host (restored=%s)', async restored => {
  const h = await recoveryFixture()
  h.watch.mockRejectedValueOnce(new Error('Original project endpoint unavailable'))
  h.sessions.mockRejectedValueOnce(new Error('Original metadata endpoint unavailable'))
  await h.render()
  await vi.waitFor(() => {
    expect(useAppStore.getState().mountedSpaceObservations[h.key]?.error).toContain('endpoint unavailable')
    expect(useAppStore.getState().mountedSpaceSessions[h.key]?.error).toContain('endpoint unavailable')
  })
  await h.emit('another-Host', restored)
  expect(h.watch).toHaveBeenCalledOnce(); expect(h.sessions).toHaveBeenCalledOnce()
  await h.emit(h.target.hostId, restored)
  await vi.waitFor(() => {
    expect(h.watch).toHaveBeenCalledTimes(2); expect(h.sessions).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().mountedSpaceObservations[h.key]?.snapshot?.reference).toEqual(h.target.reference)
    expect(useAppStore.getState().mountedSpaceSessions[h.key]?.opening?.reference).toEqual(h.target.reference)
    expect(useAppStore.getState().mountedSpaceSessions[h.key]?.reading).toBe(false)
    expect(useAppStore.getState().mountedSpaceSessions[h.key]?.error).toBeUndefined()
  })
  expect(h.watch.mock.calls[1]![0]).toEqual({ hostId: h.target.hostId, reference: h.target.reference })
  await h.emit(h.target.hostId, restored)
  expect(h.watch).toHaveBeenCalledTimes(2); expect(h.sessions).toHaveBeenCalledTimes(2)
  h.assertPreserved()
  await h.render(false); expect(h.listeners.size).toBe(0)
  await h.emit(h.target.hostId, restored)
  expect(h.watch).toHaveBeenCalledTimes(2)
})

it('a recovery preceding the old opening failure is consumed once, with late hidden results discarded', async () => {
  const h = await recoveryFixture()
  let reject!: (cause: Error) => void
  h.watch.mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
  h.sessions.mockRejectedValueOnce(new Error('Metadata unavailable'))
  await h.render()
  await h.emit()
  await vi.waitFor(() => expect(h.watch).toHaveBeenCalledTimes(2))
  await act(async () => reject(new Error('Late old project failure')))
  await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[h.key]?.snapshot).toBeDefined())
  expect(h.watch).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().mountedSpaceObservations[h.key]?.error).toBeUndefined()
  h.assertPreserved()
})

it('ready during an otherwise pending opening retries its later failure without polling', async () => {
  const h = await recoveryFixture()
  let reject!: (cause: Error) => void
  h.watch.mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
  await h.render()
  await h.emit()
  expect(h.watch).toHaveBeenCalledOnce()
  await act(async () => reject(new Error('The old opening finally failed')))
  await vi.waitFor(() => expect(h.watch).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[h.key]?.error).toBeUndefined())
  expect(h.sessions).toHaveBeenCalledTimes(2)
  h.assertPreserved()
})

it('retained source errors and snapshot remain during a retry until the new original read succeeds', async () => {
  const h = await recoveryFixture()
  await h.render()
  await vi.waitFor(() => expect(useAppStore.getState().mountedSpaceObservations[h.key]?.snapshot).toBeDefined())
  const retained = useAppStore.getState().mountedSpaceObservations[h.key]!.snapshot
  await act(async () => {
    h.watch.mock.calls[0]![1]({ type: 'error', error: { code: 'CONTROL_UNAVAILABLE', message: 'Original project stream lost' } })
    h.sessions.mock.calls[0]![1]({ type: 'error', error: { code: 'CONTROL_UNAVAILABLE', message: 'Original metadata stream lost' } })
  })
  let release!: () => void
  const gate = new Promise<void>(yes => { release = yes })
  h.watch.mockImplementationOnce(async (...args) => { await gate; return h.main.api.watch(...args) })
  h.sessions.mockImplementationOnce(async (...args) => { await gate; return h.main.api.sessions(...args) })
  await h.emit()
  await vi.waitFor(() => expect(h.watch).toHaveBeenCalledTimes(2))
  expect(useAppStore.getState().mountedSpaceObservations[h.key]?.snapshot).toBe(retained)
  expect(useAppStore.getState().mountedSpaceObservations[h.key]?.error).toBe('Original project stream lost')
  expect(useAppStore.getState().mountedSpaceSessions[h.key]?.error).toBe('Original metadata stream lost')
  expect(useAppStore.getState().mountedSpaceSessions[h.key]?.reading).toBe(true)
  await act(async () => release())
  await vi.waitFor(() => {
    expect(useAppStore.getState().mountedSpaceObservations[h.key]?.error).toBeUndefined()
    expect(useAppStore.getState().mountedSpaceSessions[h.key]?.error).toBeUndefined()
  })
  h.assertPreserved()
})

it('source connection consumers receive only their exact Host observations, independently of unrelated Session count', () => {
  let dispatch!: Parameters<typeof api.sessions.onEvent>[0]
  const release = vi.fn(), subscribe = vi.fn(listener => { dispatch = listener; return release })
  const onEvent = createRendererSessionEvents(subscribe)
  const source = vi.fn(), other = vi.fn(), semantic = vi.fn(), terminal = vi.fn()
  const off = [onEvent(source, { kind: 'host-observation', hostId: 'original-B' }),
    onEvent(other, { kind: 'host-observation', hostId: 'another-Host' }), onEvent(semantic),
    onEvent(terminal, { kind: 'agent', hostId: 'original-B', agentSessionId: 'original-session', run: { runId: 'original-run' } })]
  const evidence = { source: 'agentmux' as const, observedAt: Date.now() }
  const ready = { type: 'session-observation-state' as const, observation: { state: 'ready' as const, hasSnapshot: true }, evidence }
  dispatch({ type: 'core', hostId: 'original-B', event: ready })
  expect(source).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled(); expect(semantic).toHaveBeenCalledOnce(); expect(terminal).not.toHaveBeenCalled()
  for (let i = 0; i < 200; i++) dispatch({ type: 'core', hostId: 'original-B', event: { type: 'agent-error', agentSessionId: 'unrelated-' + i, message: 'Native observation only', evidence } } as Parameters<typeof dispatch>[0])
  expect(source).toHaveBeenCalledOnce(); expect(other).not.toHaveBeenCalled()
  dispatch({ type: 'core', hostId: 'original-B', event: { type: 'connection-state', state: 'restored', evidence } })
  expect(source).toHaveBeenCalledTimes(2); expect(terminal).toHaveBeenCalledOnce()
  off.forEach(dispose => dispose()); expect(release).toHaveBeenCalledOnce(); expect(subscribe).toHaveBeenCalledOnce()
})
