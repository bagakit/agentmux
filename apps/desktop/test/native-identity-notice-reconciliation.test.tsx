import { currentNotificationRows, notificationEventRows, toggleNotificationCenter } from './helpers/notification-center'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { useAppStore, type NotificationEvent } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

vi.mock('electron', () => ({ app: {}, nativeImage: {} }))
vi.mock('../src/main/host-factory', () => ({ createExecutionHost: (config: { id: string }) => ({ id: config.id, kind: 'local', dispose: async () => {} }) }))

const dom = composerDOM()
const original = composerSession()
const native = { kind: 'provider' as const, providerId: 'codex', sessionId: 'confirmed-main', transcriptPath: fixturePath('main.jsonl') }
const cleanups: Array<() => Promise<void>> = []
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amx-native-notice-'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.ndjson'))
  vi.stubEnv('CODEX_HOME', join(directory, 'provider'))
  useAppStore.setState({ notificationEvents: [], error: null, lastError: null, errorNoticeContext: null,
    errorDismissed: false, noticeReadReceipts: {} })
})
afterEach(async () => {
  try {
    const results = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Native identity fixture disposal failed')
  } finally {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
  }
})
function identityNotice(subject = original.control) {
  return useAppStore.getState().notificationEvents.find(record => record.context?.cause === 'AGENT_NATIVE_IDENTITY_UNCONFIRMED' &&
    record.context.subject?.hostId === subject.hostId && record.context.subject?.kind === 'agent' &&
    record.context.subject.agentSessionId === subject.agentSessionId && record.context.subject.run.runId === subject.run.runId)
}
function expectRetained(record: NotificationEvent) {
  expect(useAppStore.getState().notificationEvents).toContain(record)
  expect(currentNotificationRows(dom.container).some(row => row.dataset.noticeId === record.id)).toBe(true)
}
function expectSettled(record: NotificationEvent) {
  expect(useAppStore.getState().notificationEvents).not.toContain(record)
  expect(currentNotificationRows(dom.container).some(row => row.dataset.noticeId === record.id)).toBe(false)
}
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
function Notice() { return <GlobalSystemNotices /> }
async function showMissing() {
  await dom.render(<Notice />)
  await act(async () => useAppStore.getState().applyEvent(error()))
  const record = identityNotice()
  expect(record?.context).toMatchObject({ cause: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', subject: original.control })
  expect(record).toBeDefined()
  expectRetained(record!)
  expect(composerSubmitMode(useAppStore.getState().sessions[0]!)).toMatchObject({ canType: true, canSubmit: true })
  return record!
}

it.each([false, true])('closes the original exact-Run identity notice after confirmation (dismissed: %s)', async dismissed => {
  const record = await showMissing()
  if (dismissed) { await toggleNotificationCenter(dom.container, 'open'); await toggleNotificationCenter(dom.container, 'closed') }
  const tabs = useAppStore.getState().tabs, layouts = useAppStore.getState().layouts
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed' })))
  expectSettled(record)
  expect(useAppStore.getState().sessions[0]).toMatchObject({ id: original.id, control: original.control, nativeHandle: native })
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(dom.draft()).toBe('Keep my draft')
})

it.each(['other-session', 'other-host', 'other-run', 'candidate', 'unknown-source', 'stale-fact', 'plain-locator', 'save-unconfirmed'] as const)(
  'keeps the original notice when the observed fact is %s', async mode => {
    const record = await showMissing()
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
    expectRetained(record)
    expect(dom.draft()).toBe('Keep my draft')
  })

it.each(['ordinary', 'save-failed', 'save-unconfirmed'] as const)('does not settle a later %s notice from a main identity fact', async mode => {
  const record = await showMissing()
  await act(async () => {
    if (mode === 'ordinary') useAppStore.getState().reportError(record.message, { kind: 'indeterminate', subject: original.control })
    else useAppStore.getState().applyEvent(error(mode === 'save-failed'
      ? 'AGENT_NATIVE_IDENTITY_PERSIST_FAILED' : 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED'))
  })
  const later = useAppStore.getState().error
  expectRetained(record)
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native, nativeHandlePersistence: 'confirmed' })))
  expectSettled(record)
  expect(useAppStore.getState().error).toBe(later)
  expect(notificationEventRows(dom.container)).toHaveLength(1)
  expect(notificationEventRows(dom.container)[0]!.textContent).toContain(later)
})

it('drops a previous persistence acknowledgement when new Session facts omit it', async () => {
  useAppStore.setState({ sessions: [{ ...original, nativeHandle: native, nativeHandlePersistence: 'confirmed' }] })
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ updatedAt: _reshape_fixtureEpoch(0, 0, 3) })))
  expect(useAppStore.getState().sessions[0]).not.toHaveProperty('nativeHandlePersistence')
  const record = await showMissing()
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native })))
  expectRetained(record)
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
  const record = identityNotice()!
  expectRetained(record)
  await act(async () => release({ sessions: [{ ...original, nativeHandle: native, nativeSessionId: native.sessionId,
    nativeHandlePersistence: 'confirmed', agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 10), updatedAt: _reshape_fixtureEpoch(0, 0, 10) }], recoveryCandidates: [],
    timelines: { [original.id]: { agentSessionId: original.id, revision: 1, items: [] } } }))
  await vi.waitFor(() => expectSettled(record))
  expect(dom.draft()).toBe('Keep my draft')
})

it('keeps readable unconfirmed native identity across a missed persistence error, Main snapshots and generic Session events', async () => {
  const { nativeHandle: _oldHandle, ...durableRecord } = hookSession(original.id, original.control.run.runId)
  const f = await hookClientFixture([{ ...durableRecord, workspacePath: original.workspacePath }])
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
  const record = identityNotice()!
  expectRetained(record)
  const readable = await controller.snapshot(composerConfig)
  expect(readable.sessions[0]).toMatchObject({ nativeHandle: native, nativeHandlePersistence: 'unconfirmed' })
  await act(async () => {
    useAppStore.setState({ sessions: readable.sessions })
    useAppStore.getState().applyEvent({ type: 'core', hostId: original.hostId, event: {
      type: 'agent-session', session: f.client.agentSession(original.id)
    } })
  })
  expectRetained(record)
  await act(async () => { await controller.refresh(original.control, composerConfig) })
  await vi.waitFor(() => expectSettled(record))
  expect(useAppStore.getState().sessions[0]).toMatchObject({ control: original.control, nativeHandle: native,
    nativeHandlePersistence: 'confirmed' })
  expectSettled(record)
  expect(dom.draft()).toBe('Keep my draft')
})


it('keeps two native subjects current through ordinary history, wrong facts and independent confirmed settlement', async () => {
  const secondaryBase = composerSession('agent-secondary')
  const secondary = { ...secondaryBase, hostId: 'secondary-host', label: 'Secondary Agent',
    control: { ...secondaryBase.control, hostId: 'secondary-host' } }
  useAppStore.setState({ sessions: [original, secondary],
    agentComposerDrafts: { [original.id]: 'Keep my draft', [secondary.id]: 'Secondary draft' } })
  const tabs = useAppStore.getState().tabs, layouts = useAppStore.getState().layouts
  const first = await showMissing()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: secondary.hostId, event: {
    type: 'agent-error', agentSessionId: secondary.id,
    code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: first.message,
    evidence: { source: 'agentmux', run: secondary.control.run, observedAt: _reshape_fixtureEpoch(0, 0, 2) }
  } }))
  const second = identityNotice(secondary.control)!
  expect(second).toBeDefined()
  expectRetained(first); expectRetained(second)
  expect(currentNotificationRows(dom.container).filter(row => row.dataset.noticeId === first.id || row.dataset.noticeId === second.id)).toHaveLength(2)
  await act(async () => useAppStore.getState().reportError('Independent clipboard failure'))
  expect(notificationEventRows(dom.container)).toHaveLength(1)
  await toggleNotificationCenter(dom.container, 'open')
  await toggleNotificationCenter(dom.container, 'closed')
  await act(async () => useAppStore.getState().clearReadNotificationEvents())
  expect(notificationEventRows(dom.container)).toHaveLength(0)
  expectRetained(first); expectRetained(second)
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({
    agentSessionId: 'foreign-agent', nativeHandle: native, nativeHandlePersistence: 'confirmed',
    run: { runId: 'foreign-run' }
  })))
  expectRetained(first); expectRetained(second)
  const secondaryFact = { agentSessionId: secondary.id, hostId: secondary.hostId, run: secondary.control.run,
    nativeHandle: { ...native, sessionId: 'confirmed-secondary' }, nativeHandlePersistence: 'confirmed' as const }
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ ...secondaryFact,
    nativeSourceObservation: { state: 'unknown', run: secondary.control.run,
      observedAt: _reshape_fixtureEpoch(0, 0, 10), reason: 'source unavailable' }
  }, secondary.hostId)))
  expectRetained(first); expectRetained(second)
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ ...secondaryFact,
    nativeHandlePersistence: 'unconfirmed' }, secondary.hostId)))
  expectRetained(first); expectRetained(second)
  await act(async () => useAppStore.getState().applyEvent(sessionEvent(secondaryFact, secondary.hostId)))
  expectRetained(first); expectSettled(second)
  expect(currentNotificationRows(dom.container).filter(row => row.dataset.noticeId === first.id || row.dataset.noticeId === second.id)).toHaveLength(1)
  await act(async () => useAppStore.getState().applyEvent(sessionEvent({ nativeHandle: native,
    nativeHandlePersistence: 'confirmed', updatedAt: _reshape_fixtureEpoch(0, 0, 20) })))
  expectSettled(first)
  expect(currentNotificationRows(dom.container).filter(row => row.dataset.noticeId === first.id || row.dataset.noticeId === second.id)).toHaveLength(0)
  expect(useAppStore.getState().tabs).toBe(tabs); expect(useAppStore.getState().layouts).toBe(layouts)
  expect(dom.draft()).toBe('Keep my draft'); expect(dom.draft(secondary.id)).toBe('Secondary draft')
  expect(composerSubmitMode(useAppStore.getState().sessions.find(session => session.id === secondary.id)!))
    .toMatchObject({ canType: true, canSubmit: true })
})
