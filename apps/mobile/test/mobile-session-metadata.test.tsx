import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract'
import { AgentTerminalScreen } from '../../../packages/core/src/agent-terminal-screen'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port'
import { connectedClient, AGENT_SESSION_ID as sid, RUN_ID } from '../../../packages/core/test/fixtures/interaction-client'
import { useHostedConversation } from '../src/conversation/use-hosted-conversation'
import { useMobilePromptController } from '../src/conversation/use-mobile-prompt-controller'
import { useMobileLocalDrafts } from '../src/conversation/local-drafts-owner'
import { emptyDeviceWorkface, getDeviceWorkface } from '../src/recovery/device-workface'
import { mount, mounted, deferred } from './conversation-fixture'

const closes: Array<() => Promise<unknown>> = []
beforeEach(async () => { localStorage.clear(); await getDeviceWorkface().replaceBackup(emptyDeviceWorkface()) })
afterEach(async () => {
  for (const view of mounted.splice(0)) { await act(async () => view.root.unmount()); view.element.remove() }
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

/** Actual Mobile hooks -> serialized Hosted SDK/service -> Core registry/store/admission.
 * Only original Provider history and ctxmux transport leaves are controlled. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mobile-metadata-'))
  closes.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const h = await connectedClient(undefined, 'codex', 'metadata-native')
  const journalReads = new Set<Promise<unknown>>(), queue = (h.client as any).messageQueue
  const messageChanges = queue.messageChanges.bind(queue)
  vi.spyOn(queue, 'messageChanges').mockImplementation((...args: any[]) => {
    const pending = messageChanges(...args); journalReads.add(pending)
    void pending.then(() => journalReads.delete(pending), () => journalReads.delete(pending))
    return pending
  })
  closes.push(async () => {
    await h.client.dispose()
    while (journalReads.size) await Promise.allSettled([...journalReads])
    await (h.client as any).startupDiagnostics.dispose()
  })
  vi.spyOn(h.client, 'connect').mockResolvedValue()
  const provider = h.client.providers.get('codex')
  provider.planPromptInput = prompt => ({ kind: 'single-phase', data: prompt + '\r' })
  vi.spyOn(provider, 'discoverNativeSession').mockResolvedValue({ handle: { kind: 'provider', providerId: 'codex', sessionId: 'metadata-native' }, assertCurrent: async () => {} })
  vi.spyOn(provider, 'readPromptExecutionEvidence').mockResolvedValue({ state: 'idle', id: 'metadata-idle', sourceId: 'metadata-native' })
  vi.spyOn(provider, 'verifyPromptExecutionTransport').mockResolvedValue(true)
  const source = { providerId: 'codex', nativeSessionId: 'metadata-native' }
  vi.spyOn(provider, 'readSessionHistoryPage').mockResolvedValue({ source, items: [], nextCursor: null, changesCursor: 'metadata-cut' })
  vi.spyOn(provider, 'readConversationChanges').mockResolvedValue({ source, items: [], cursor: 'metadata-cut', more: false })
  vi.spyOn(provider, 'observeSessionHistory').mockResolvedValue({ source, dispose() {} })
  const screen = new AgentTerminalScreen(80, 24); closes.push(async () => screen.dispose())
  vi.spyOn((h.client as any).screenEvidence, 'wait').mockImplementation(async (...args: any[]) => { args[3](screen); return 1 })
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'retained-body', agentSessionId: sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Retained answer', content: 'Original retained conversation body', createdAt: 1, updatedAt: 1 } })
  const service = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client))
  closes.push(() => service.dispose())
  const wire = (value: unknown) => JSON.parse(JSON.stringify(value))
  const pending = new Set<Promise<unknown>>()
  let metadataBarrier: ReturnType<typeof deferred<void>> | null = null
  async function tracked<T>(value: Promise<T>): Promise<T> { pending.add(value); try { return await value } finally { pending.delete(value) } }
  const port = {
    call: (method: string, params: unknown, options?: { signal?: AbortSignal }) => tracked((async () => {
      const value = await service.call(method, wire(params), options)
      if (method === 'runtime.invoke' && (params as any)?.invocation?.method === 'readAgentSession') await metadataBarrier?.promise
      return wire(value)
    })()),
    subscribe: (method: string, params: unknown, handlers: any) => tracked((async () => {
      const stream = await service.subscribe(method, wire(params), event => handlers.onEvent(wire(event)), { signal: handlers.signal })
      handlers.onInitial(wire(stream.initial)); await stream.start?.(); return { dispose: () => stream.dispose() }
    })())
  } as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port })
  closes.push(async () => { await client.dispose(); while (pending.size) await Promise.allSettled([...pending]) })
  closes.push(async () => { metadataBarrier?.resolve(); metadataBarrier = null })
  const read = vi.spyOn(h.client, 'readAgentSession'), inventory = vi.spyOn(h.client, 'readAgentSessions')
  const submit = vi.spyOn(h.client, 'submitAgentPrompt'), resume = vi.spyOn(h.client, 'ensureAgentContinuity'), stop = vi.spyOn(h.client, 'stopAgent')
  // Failure injection belongs only to the synchronous SDK cache, never a business owner.
  vi.spyOn(client, 'agentSession').mockImplementation(() => { throw new Error('Controlled SDK cache miss') })
  return { ...h, core: h.client, client, read, inventory, submit, resume, stop, holdMetadata() {
    const held = deferred<void>(); metadataBarrier = held
    return () => { held.resolve(); if (metadataBarrier === held) metadataBarrier = null }
  } }
}

type Observation = { reading: ReturnType<typeof useHostedConversation>; prompt: ReturnType<typeof useMobilePromptController> }
function Consumer({ f, active, observed }: { f: Awaited<ReturnType<typeof fixture>>; active: boolean; observed(value: Observation): void }) {
  const reading = useHostedConversation(f.client, sid, active), local = useMobileLocalDrafts()
  const prompt = useMobilePromptController({ local, client: f.client, agentSessionId: sid, session: reading.session, sessionState: reading.metadata.state,
    timeline: reading.timeline, connection: { state: 'connected', message: 'Original connected Mac' }, disconnected: reading.disconnected, visible: active, refresh: reading.refresh })
  observed({ reading, prompt })
  return <section><output data-metadata={reading.metadata.state}>{reading.metadata.issue}</output>
    <article>{reading.timeline?.items.map(item => item.content).join('\n')}</article>
    <textarea aria-label="Current draft" value={prompt.draft} onChange={event => prompt.setDraft(event.target.value)} />
    <button disabled={!prompt.available} onClick={() => void prompt.submit()}>Send</button>
    <button onClick={() => void reading.refresh()}>Check original metadata</button></section>
}
async function consume(f: Awaited<ReturnType<typeof fixture>>) {
  let observation!: Observation
  const render = (active = true) => <Consumer f={f} active={active} observed={value => { observation = value }} />
  const view = await mount(render())
  return { ...view, observation: () => observation, visible: async (active: boolean) => view.render(render(active)) }
}
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 5000 }) }

it('cache-miss active metadata reaches the exact Hosted/Core owner and sends one original manual input without inventory or recovery', async () => {
  const f = await fixture(), view = await consume(f)
  await wait(() => expect(view.observation().reading.metadata.state).not.toBe('loading'))
  expect(view.observation().reading.metadata.state).toBe('active')
  expect(view.observation().reading.metadataClient).toBe(f.client)
  expect(view.observation().reading.session?.agentSessionId).toBe(sid)
  expect(f.read).toHaveBeenCalledWith(sid); expect(f.inventory).not.toHaveBeenCalled()
  expect(() => f.client.agentSession(sid)).toThrow('cache miss')
  await act(async () => view.observation().prompt.setDraft('Exact ordinary message after missing cache'))
  await act(async () => { await view.observation().prompt.submit() })
  await wait(() => expect(f.writes.join('')).toContain('Exact ordinary message after missing cache'))
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: sid, expectedRun: { runId: RUN_ID }, execution: 'immediate', admissionIntent: { kind: 'manual-actor' } })
  expect(f.resume).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  const release = f.holdMetadata()
  await act(async () => view.observation().prompt.setDraft('Unsent draft before its reader closes'))
  const before = f.read.mock.calls.length
  let sending!: Promise<void>
  await act(async () => { sending = view.observation().prompt.submit() })
  await wait(() => expect(f.read.mock.calls.length).toBeGreaterThan(before))
  const index = mounted.findIndex(item => item.element === view.element), originalView = mounted.splice(index, 1)[0]!
  await act(async () => originalView.root.unmount()); view.element.remove()
  await act(async () => { release(); await sending })
  expect(f.submit).toHaveBeenCalledOnce()
  expect(f.writes.join('')).not.toContain('Unsent draft before its reader closes')
  expect(getDeviceWorkface().snapshot().record.conversation.drafts).toContainEqual([JSON.stringify(['draft', sid]), 'Unsent draft before its reader closes'])
})

it('retired exact descriptors preserve original history and draft without sending or reopening the isolated Session', async () => {
  const f = await fixture(), current = await f.store.readMetadata(sid)
  const reservation = { kind: 'stop' as const, reservationId: 'metadata-retirement', ownerId: 'metadata-owner', ownerPid: process.pid,
    agentSessionId: sid, expectedRun: current!.run, operationId: 'metadata-retirement-operation', expiresAt: Date.now() + 60000,
    stopOperation: { daemonInstance: 'isolated-metadata-runtime', operationKey: 'metadata-stop', runId: RUN_ID } }
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  const view = await consume(f)
  await wait(() => expect(view.observation().reading.metadata.state).not.toBe('loading'))
  expect(view.observation().reading.metadata.state).toBe('retired')
  await wait(() => expect(view.element.querySelector('article')?.textContent).toContain('Original retained conversation body'))
  expect(view.observation().reading.session).toBeNull()
  await act(async () => view.observation().prompt.setDraft('Retained retired conversation draft'))
  expect(view.element.querySelector('textarea')?.value).toBe('Retained retired conversation draft')
  expect(view.observation().prompt.available).toBe(false)
  await act(async () => { await view.observation().prompt.submit() })
  expect(f.submit).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  expect(f.resume).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  expect(view.observation().prompt.draft).toBe('Retained retired conversation draft')
  const retired = await f.store.readRetiredAgentSession(sid)
  const deletion = await f.store.deleteRecord(retired!, 'isolated-record-delete')
  await f.store.cleanRecord(deletion.retirement); await f.store.confirmRecordDeletion(deletion.retirement)
  await act(async () => { await view.observation().reading.refresh() })
  await wait(() => expect(view.observation().reading.metadata.state).toBe('deleted'))
  expect(view.observation().prompt.available).toBe(false)
  expect(view.observation().prompt.draft).toBe('Retained retired conversation draft')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it('explicit metadata refresh while parked clears only the resolved metadata issue through its original owner', async () => {
  const f = await fixture(), normalRead = f.store.readMetadata.bind(f.store)
  let unavailable = true
  vi.spyOn(f.store, 'readMetadata').mockImplementation(async id => {
    if (unavailable && id === sid) throw new Error('Controlled exact metadata read unavailable')
    return normalRead(id)
  })
  const view = await consume(f)
  await wait(() => expect(view.observation().reading.metadata.state).toBe('unconfirmed'))
  expect(view.observation().reading.metadata.issue).toContain('Controlled exact metadata read unavailable')
  await act(async () => (f.core as any).publisher.publish({ type: 'agent-error', agentSessionId: sid, code: 'ISOLATED_SOURCE_ISSUE',
    message: 'Independent original source issue', evidence: { source: 'agentmux', observedAt: Date.now(), run: { runId: RUN_ID } } }))
  await wait(() => expect(view.observation().reading.agentIssue).toBe('Independent original source issue'))
  await act(async () => view.observation().prompt.setDraft('Later draft during metadata failure'))
  await view.visible(false)
  const reads = f.read.mock.calls.length; unavailable = false
  await act(async () => { await view.observation().reading.refresh() })
  await wait(() => expect(view.observation().reading.metadata.state).toBe('active'))
  expect(f.read.mock.calls.length).toBeGreaterThan(reads)
  expect(view.observation().reading.metadata.issue).toBeNull()
  expect(view.observation().reading.agentIssue).toBe('Independent original source issue')
  expect(view.observation().reading.metadataClient).toBe(f.client)
  expect(view.observation().prompt.draft).toBe('Later draft during metadata failure')
  expect(f.inventory).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled()
  expect(f.resume).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled(); expect(f.writes).toEqual([])
  // Keep the real metadata owner; delay its transport reply while the same SDK object
  // observes a different Core instance. No old completion may be accepted there.
  const owner = f.client.runtimeOwnerIdentity()!, release = f.holdMetadata()
  let observedOwner = owner
  vi.spyOn(f.client, 'runtimeOwnerIdentity').mockImplementation(() => observedOwner)
  const priorMetadata = view.observation().reading.metadata, beforeLateRead = f.read.mock.calls.length
  let checking!: Promise<void>
  await act(async () => { checking = view.observation().reading.refresh() })
  await wait(() => expect(f.read.mock.calls.length).toBeGreaterThan(beforeLateRead))
  observedOwner = { ...owner, ownerInstanceId: 'isolated-replacement-instance' }
  await act(async () => { release(); await checking })
  expect(view.observation().reading.metadata).toBe(priorMetadata)
  expect(view.observation().prompt.draft).toBe('Later draft during metadata failure')
  observedOwner = owner
})
