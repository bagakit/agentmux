const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { AgentMuxSessionDurabilityError } from '../../../packages/core/src/agent-session-store'
import { DurableWriteError } from '../../../packages/core/src/durable-write'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { AgentMuxHostedTransferReader } from '../../../packages/core/src/hosted-value'
import type { AgentMuxHostedRpcPort, AgentMuxHostedStreamInitial, AgentMuxHostedStreamMethod } from '../../../packages/core/src/hosted-client-contract'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { hookClientFixture, hookSession } from '../../../packages/core/test/helpers/hook-ingress-fixture'
import { RuntimeController } from '../src/main/runtime-controller'
import type { AgentMuxAgentSession } from '@agentmux/core'
import type { RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { composerSubmitMode } from '../src/renderer/src/lib/composer-submit-mode'
import { useAppStore } from '../src/renderer/src/store'
import { TransientErrorNotice } from '../src/renderer/src/components/TransientErrorNotice'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
vi.mock('../src/main/host-factory', () => ({ createExecutionHost: (config: { id: string }) => ({ id: config.id, kind: 'local', dispose: async () => {} }) }))

const dom = composerDOM()
const original = composerSession()
const native = { kind: 'provider' as const, providerId: 'codex', sessionId: 'confirmed-main', transcriptPath: fixturePath('main.jsonl') }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fact(extra: Partial<AgentMuxAgentSession> = {}): AgentMuxAgentSession {
  return { kind: 'agent', agentSessionId: original.id, providerId: original.providerId, executorId: original.executorId,
    hostId: original.hostId, workspacePath: original.workspacePath, run: original.control.run,
    retiredRuns: [], createdAt: original.createdAt, updatedAt: _reshape_fixtureEpoch(0, 0, 10), ...extra }
}
function error(code = 'AGENT_NATIVE_IDENTITY_UNCONFIRMED'): RuntimeEvent {
  return { type: 'core', hostId: original.hostId, event: { type: 'agent-error', agentSessionId: original.id, code,
    message: 'Controlled native identity observation remains unconfirmed.',
    evidence: { source: 'agentmux', run: original.control.run, observedAt: _reshape_fixtureEpoch(0, 0, 2) } } }
}
function sessionEvent(extra: Partial<AgentMuxAgentSession> = {}, hostId = original.hostId): RuntimeEvent {
  return { type: 'core', hostId, event: { type: 'agent-session', session: fact(extra) } }
}
function Notice() {
  const state = useAppStore()
  return <TransientErrorNotice error={state.error} dismissed={state.errorDismissed} lastError={state.lastError}
    summary={state.errorNoticeContext?.summary} onDismiss={state.dismissError} onReopen={state.reopenError}
    kind={state.errorNoticeContext?.kind ?? 'indeterminate'} />
}
async function showMissing() {
  await dom.render(<Notice />)
  await act(async () => useAppStore.getState().applyEvent(error()))
  expect(useAppStore.getState().errorNoticeContext).toMatchObject({ cause: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', subject: original.control })
  expect(dom.container.querySelector('.error-notice')).not.toBeNull()
  expect(composerSubmitMode(useAppStore.getState().sessions[0]!)).toMatchObject({ canType: true, canSubmit: true })
  return useAppStore.getState().error
}

it.each([false, true])('closes the original exact-Run identity notice after confirmation (dismissed: %s)', async dismissed => {
  await showMissing()
  if (dismissed) await dom.click('[aria-label="Dismiss error"]')
  const tabs = useAppStore.getState().tabs, layouts = useAppStore.getState().layouts
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed' })))
  expect(useAppStore.getState()).toMatchObject({ error: null, lastError: null, errorNoticeContext: null, errorDismissed: false })
  expect(dom.container.querySelector('.error-notice')).toBeNull()
  expect(dom.container.querySelector('.error-notice__reopen')).toBeNull()
  expect(useAppStore.getState().sessions[0]).toMatchObject({ id: original.id, control: original.control, nativeHandle: native })
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(dom.draft()).toBe('Keep my draft')
})

it.each(['other-session', 'other-host', 'other-run', 'candidate', 'unknown-source', 'stale-fact', 'plain-locator', 'save-unconfirmed'] as const)(
  'keeps the original notice when the observed fact is %s', async mode => {
    const message = await showMissing()
    let incoming = sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed' })
    if (mode === 'other-session') incoming = sessionEvent({ agentSessionId: 'another-session', nativeHandle: native, nativeHandlePersistence: 'confirmed' })
    else if (mode === 'other-host') incoming = sessionEvent({ hostId: 'another-host', nativeHandle: native, nativeHandlePersistence: 'confirmed' }, 'another-host')
    else if (mode === 'other-run') incoming = sessionEvent({ run: { runId: 'replacement-run' }, retiredRuns: [original.control.run], nativeHandle: native, nativeHandlePersistence: 'confirmed' })
    else if (mode === 'candidate') incoming = sessionEvent({ observedNativeHandle: native })
    else if (mode === 'unknown-source') incoming = sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed',
      nativeSourceObservation: { state: 'unknown', run: original.control.run, observedAt: _reshape_fixtureEpoch(0, 0, 10), reason: 'current-main-unconfirmed' } })
    else if (mode === 'plain-locator') incoming = sessionEvent({ nativeHandle: native })
    else if (mode === 'save-unconfirmed') incoming = sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'unconfirmed' })
    else {
      await act(async () => useAppStore.setState({ sessions: [{ ...original, agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 20), updatedAt: _reshape_fixtureEpoch(0, 0, 20) }] }))
      incoming = sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed', updatedAt: _reshape_fixtureEpoch(0, 0, 10) })
    }
    await act(async () => useAppStore.getState().applyEvent(incoming))
    expect(useAppStore.getState().error).toBe(message)
    expect(dom.container.querySelector('.error-notice')).not.toBeNull()
    expect(dom.draft()).toBe('Keep my draft')
  })

it.each(['ordinary', 'save-failed', 'save-unconfirmed'] as const)('does not settle a later %s notice from a main identity fact', async mode => {
  const message = await showMissing()
  await act(async () => {
    if (mode === 'ordinary') useAppStore.getState().reportError(message, { kind: 'indeterminate', subject: original.control })
    else useAppStore.getState().applyEvent(error(mode === 'save-failed'
      ? 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED' : 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED'))
  })
  const later = useAppStore.getState().error
  expect(useAppStore.getState().errorNoticeContext?.cause).toBeUndefined()
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed' })))
  expect(useAppStore.getState().error).toBe(later)
  expect(dom.container.querySelector('.error-notice')).not.toBeNull()
})

it('drops a previous persistence acknowledgement when new Session facts omit it', async () => {
  useAppStore.setState({ sessions: [{ ...original, nativeHandle: native, nativeHandlePersistence: 'confirmed' }] })
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ updatedAt: _reshape_fixtureEpoch(0, 0, 3) })))
  expect(useAppStore.getState().sessions[0]).not.toHaveProperty('nativeHandlePersistence')
  const message = await showMissing()
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native })))
  expect(useAppStore.getState().error).toBe(message)
  expect(dom.container.querySelector('.error-notice')).not.toBeNull()
})

it('does not resurrect a buffered original identity failure after the same membership read confirms it', async () => {
  let release!: (snapshot: RuntimeSnapshot) => void
  const snapshot = vi.spyOn(api.sessions, 'snapshot').mockImplementation(() => new Promise(resolve => { release = resolve }))
  await dom.render(<Notice />)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: original.hostId, event: {
    type: 'connection-state', state: 'restored', evidence: { source: 'run-process', observedAt: _reshape_fixtureEpoch(0, 0, 1) }
  } }))
  await vi.waitFor(() => expect(snapshot).toHaveBeenCalled())
  await act(async () => useAppStore.getState().applyEvent(error()))
  expect(dom.container.querySelector('.error-notice')).not.toBeNull()
  await act(async () => release({ sessions: [{ ...original, nativeHandle: native, nativeSessionId: native.sessionId,
    nativeHandlePersistence: 'confirmed', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 10), updatedAt: _reshape_fixtureEpoch(0, 0, 10) }], recoveryCandidates: [],
    timelines: { [original.id]: { agentSessionId: original.id, revision: 1, items: [] } } }))
  await vi.waitFor(() => expect(useAppStore.getState().error).toBeNull())
  expect(dom.container.querySelector('.error-notice')).toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})

it('keeps readable unconfirmed native identity across a missed persistence error, Main snapshots and generic Session events', async () => {
  const { nativeHandle: _oldHandle, ...record } = hookSession(original.id, original.control.run.runId)
  const f = await hookClientFixture([{ ...record, workspacePath: original.workspacePath }])
  const service = new AgentMuxHostedRuntimeService(f.client, null, () => hostedTestOwner(f.client))
  const port = {
    call: async (method: string, params: unknown, context?: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await service.call(method, JSON.parse(JSON.stringify(params)), context))),
    subscribe: async (method: string, params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      const reader = new AgentMuxHostedTransferReader(), frames: Parameters<typeof handlers.onEvent>[0][] = []
      const stream = await service.subscribe(method, JSON.parse(JSON.stringify(params)), event => {
        // A lost diagnostic is an observation gap, never a durable save acknowledgement.
        if (event.type !== 'snapshot') { handlers.onEvent(event); return }
        frames.push(event)
        const value = reader.accept(event.data) as { kind: string; event?: { type: string; code?: string } } | undefined
        if (!value) return
        const complete = frames.splice(0)
        if (value.kind === 'event' && value.event?.type === 'agent-error' && value.event.code === 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED') return
        for (const frame of complete) handlers.onEvent(frame)
      }, handlers.signal ? { signal: handlers.signal } : {})
      handlers.onInitial(stream.initial as AgentMuxHostedStreamInitial<AgentMuxHostedStreamMethod>); await stream.start?.()
      return { dispose: async () => { await stream.dispose() } }
    }
  } as AgentMuxHostedRpcPort
  const hosted = await connectHostedAgentMux({ rpc: port }), controller = new RuntimeController(f.store, async () => hosted)
  let detach = () => {}
  cleanups.push(async () => { detach(); await controller.dispose(); await service.dispose(); await f.client.dispose() })
  controller.commit(await controller.prepare(composerConfig))
  const initial = await controller.snapshot(composerConfig)
  expect(initial.sessions).toHaveLength(1)
  useAppStore.setState({ sessions: initial.sessions })
  detach = controller.attach(Object.assign(new EventEmitter(), {
    id: 186, isDestroyed: () => false,
    send: (_channel: string, event: RuntimeEvent) => useAppStore.getState().applyEvent(event)
  }) as any)
  await showMissing()
  const actual = f.store.compareAndSwapMetadata.bind(f.store)
  vi.spyOn(f.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    await actual(...args)
    throw new AgentMuxSessionDurabilityError(new DurableWriteError(fixturePath('test-store'), 'after-replace', new Error('controlled native save EIO')))
  })
  await expect(f.inner.registry.update(original.id, original.control.run, value => ({ ...value,
    nativeHandle: native, updatedAt: Date.now() }))).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED' })
  expect(f.inner.registry.isDurabilityUnconfirmed(original.id)).toBe(true)
  const message = useAppStore.getState().error
  expect(useAppStore.getState().errorNoticeContext?.cause).toBe('AGENT_NATIVE_IDENTITY_UNCONFIRMED')
  const readable = await controller.snapshot(composerConfig)
  expect(readable.sessions[0]).toMatchObject({ nativeHandle: native, nativeHandlePersistence: 'unconfirmed' })
  await act(async () => {
    useAppStore.setState({ sessions: readable.sessions })
    useAppStore.getState().applyEvent({ type: 'core', hostId: original.hostId, event: {
      type: 'agent-session', session: f.client.agentSession(original.id)
    } })
  })
  expect(useAppStore.getState().error).toBe(message)
  expect(dom.container.querySelector('.error-notice')).not.toBeNull()
  await act(async () => { await controller.refresh(original.control, composerConfig) })
  await vi.waitFor(() => expect(useAppStore.getState().error).toBeNull())
  expect(useAppStore.getState().sessions[0]).toMatchObject({ control: original.control, nativeHandle: native,
    nativeHandlePersistence: 'confirmed' })
  expect(dom.container.querySelector('.error-notice')).toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})
