// @vitest-environment happy-dom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { parseReadingDiagnosticRecord, type ReadingDiagnosticEvent, type ReadingDiagnosticRecord } from '../../../packages/core/src/reading-diagnostic'
import type { ConversationObservation } from '../../../packages/core/src/conversation-changes'
import { useConversationView, type ConversationViewClient } from '../../../packages/client-ui/src/lib/use-conversation-view'
import type { ConversationViewDiagnostics } from '../../../packages/client-ui/src/lib/conversation-reading-diagnostics'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useAppStore } from '../src/renderer/src/store'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'
import { activityReadingProps } from './helpers/activity-reading-props'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { ClientIncidentIpcOwner } from '../src/main/client-incident-ipc'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
import type { AgentMuxClientIncidentPage, AgentMuxClientIncidentReport, AgentMuxClientIncidentRecord } from '../../../packages/core/src/client-incident'
import type { IpcMainInvokeEvent, WebContents } from 'electron'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  window.getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  for (const close of closes.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (failures.length) throw new AggregateError(failures, 'Private reading diagnostic fixture cleanup failed')
})
const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
const wait = (assertion: () => unknown | Promise<unknown>) => vi.waitFor(async () => { await pause(); await assertion() }, { timeout: 10000, interval: 20 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function setupDom(strictRoot = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const host = document.createElement('div'); document.body.append(host)
  const root = strictRoot ? createRoot(host) : createClientUiRoot(host)
  let mounted = true
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); host.remove() } }
  closes.push(unmount)
  return { host, root, unmount }
}
const native = (id: string, content: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content } })
const tool = (id: string) => ({ type: 'assistant', uuid: id, sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-' + id, name: 'shell', input: { command: 'private-command-marker' } }] } })
function diagnostics(records: ReadingDiagnosticRecord[], publish?: ConversationViewDiagnostics['publish']): ConversationViewDiagnostics {
  return { ownerInstanceId: 'original-renderer-producer', producerBuildId: null, consumerKind: 'conversation-pane',
    publish: publish ?? (record => { records.push(parseReadingDiagnosticRecord(record)) }) }
}
function events(records: readonly ReadingDiagnosticRecord[], consumerId?: string): ReadingDiagnosticEvent[] {
  const seen = new Map<string, ReadingDiagnosticEvent>()
  for (const record of records) {
    if (consumerId !== undefined && record.scope.consumerId !== consumerId) continue
    for (const event of record.events) seen.set(JSON.stringify([record.scope.consumerId, event.sequence]), event)
  }
  return [...seen.values()]
}
async function capturePublications(f: Awaited<ReturnType<typeof nativeHistoryFixture>>, records: ReadingDiagnosticRecord[]) {
  const archive = new ClientIncidentArchive(join(f.root, 'reading-evidence'))
  await archive.flush()
  closes.push(() => archive.flush())
  const frame = {}, contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const ipc = new ClientIncidentIpcOwner({ archive, contents, windowId: 17, generation: () => 1, buildId: () => null })
  const publication = vi.fn(async (token: string, report: AgentMuxClientIncidentReport) => {
    const receipt = ipc.report(event, token, report)
    if (receipt.accepted && report.reading) records.push(parseReadingDiagnosticRecord(report.reading))
    return receipt
  })
  vi.stubGlobal('agentmux', { clientIncidents: { open: async () => ipc.open(event), report: publication } })
  const service = new AgentMuxRpcService({ clientIncidents: () => archive, coreClients: () => [] })
  closes.push(() => service.dispose())
  return { publication, async readRetained() {
    await archive.flush()
    const query = { target: { domain: 'client.incident' as const, hostId: 'local',
      recent: { agentSessionId: f.session.agentSessionId, limit: 32 } } }
    const found = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', query), query)
    expect(found.reads[0]!.availability).toBe('found')
    expect(found.reads[0]!.authorityStatus).toBe('verified')
    const page = found.reads[0]!.data as AgentMuxClientIncidentPage
    expect(page.kind).toBe('client-incident-page')
    expect(page.coverage).toMatchObject({ startup: 'ready', pendingWrites: 0, writeFailures: 0, indexFailures: 0 })
    const originals: AgentMuxClientIncidentRecord[] = []
    const acceptedIds = new Set(records.map(record => record.logId))
    for (const item of page.items) {
      const ref = item.recordRef
      const target = { domain: 'client.incident' as const, hostId: ref.routeHostId!, logId: ref.logId,
        authority: { kind: ref.authority!.kind, id: ref.authority!.id } }
      const read = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', { target }), { target }).reads[0]!
      expect(read.availability).toBe('found')
      expect(read.authorityStatus).toBe('verified')
      expect(read.persistence, 'A memory-only record cannot certify durable retention').toBe('confirmed')
      expect(read.recordRef!.logId).toBe(ref.logId)
      expect(acceptedIds.has(ref.logId), 'The public lookup must preserve an actually accepted producer log ID').toBe(true)
      const original = read.data as AgentMuxClientIncidentRecord
      expect(original.report.reading!.logId).toBe(ref.logId)
      expect(original.producer).toMatchObject({ kind: 'renderer', appInstanceId: archive.appInstanceId,
        windowId: '17', documentGeneration: '1', buildId: null })
      if (originals.length) expect(original.producer.producerInstanceId).toBe(originals[0]!.producer.producerInstanceId)
      originals.push(original)
    }
    return originals
  } }
}

it('assigns distinct StrictMode lifetimes while preserving the ended original reader and successful current reader', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([native('original-input', 'private-body-marker')]))
  closes.push(f.close)
  const dom = setupDom(true), records: ReadingDiagnosticRecord[] = [], reporting = diagnostics(records)
  let view!: ReturnType<typeof useConversationView>
  function Probe() {
    view = useConversationView(f.client, { hostId: 'local', agentSessionId: f.session.agentSessionId }, true, { diagnostics: reporting })
    return <output>{view.snapshot?.agentSessionId}</output>
  }
  await act(async () => dom.root.render(<StrictMode><Probe /></StrictMode>))
  await wait(() => { expect(view.snapshot).not.toBeNull(); expect(view.loading).toBe(false); expect(view.inspect().dirty).toBe(false) })
  const started = records.filter(record => record.events.some(event => event.phase === 'consumer-started'))
  const lifetimes = [...new Set(started.map(record => record.scope.consumerId))]
  expect(lifetimes, 'StrictMode remount must not reuse the old diagnostic lifetime').toHaveLength(2)
  expect(events(records, lifetimes[0]).some(event => event.phase === 'consumer-ended')).toBe(true)
  const currentEvents = events(records, lifetimes[1])
  expect(currentEvents.some(event => event.phase === 'assembly-complete')).toBe(true)
  expect(currentEvents.some(event => event.phase === 'admission-accepted')).toBe(true)
  expect(currentEvents.some(event => event.phase === 'consumer-ended')).toBe(false)
  expect(records.every(record => record.scope.agentSessionId === f.session.agentSessionId)).toBe(true)
  expect(JSON.stringify(records)).not.toContain('private-body-marker')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('terminates superseded attempts and keeps delayed results and disposed watch callbacks on their original Session', async () => {
  const a = await nativeHistoryFixture('claude', jsonl([native('first-input', 'first-private-body')]), { agentSessionId: 'first-original-session' })
  const b = await nativeHistoryFixture('claude', jsonl([native('second-input', 'second-private-body')]), { agentSessionId: 'second-original-session' })
  closes.push(a.close, b.close)
  const dom = setupDom(), records: ReadingDiagnosticRecord[] = [], reporting = diagnostics(records)
  const release = deferred<void>(), requested = deferred<void>()
  closes.push(() => release.resolve())
  let delayed = false
  const listeners: Array<(value: ConversationObservation) => void> = []
  const first: ConversationViewClient = {
    readAgentConversation: async (input, options) => {
      const page = await a.client.readAgentConversation(input, options)
      if (delayed) { delayed = false; requested.resolve(); await release.promise }
      return page
    },
    readConversationChanges: (input, options) => a.client.readConversationChanges(input, options),
    observeConversation: (input, listener, options) => { listeners.push(listener); return a.client.observeConversation(input, listener, options) },
    releaseConversationView: input => a.client.releaseConversationView(input)
  }
  let view!: ReturnType<typeof useConversationView>
  function Probe({ client, sessionId }: { client: ConversationViewClient; sessionId: string }) {
    view = useConversationView(client, { hostId: 'local', agentSessionId: sessionId }, true, { diagnostics: reporting })
    return <output>{view.snapshot?.agentSessionId}</output>
  }
  await act(async () => dom.root.render(<Probe client={first} sessionId={a.session.agentSessionId} />))
  await wait(() => { expect(view.snapshot).not.toBeNull(); expect(view.inspect().dirty).toBe(false); expect(view.loading).toBe(false) })
  const firstLifetime = records[0]!.scope.consumerId
  delayed = true
  let pending!: Promise<void>
  await act(async () => { pending = view.refresh(); await requested.promise })
  const firstAttempt = events(records, firstLifetime).filter(event => event.phase === 'read-started').at(-1)!.attemptId
  expect(events(records, firstLifetime).some(event => event.phase === 'assembly-complete' && event.attemptId === firstAttempt),
    'An in-flight read must publish its start before any completed assembly exists').toBe(false)
  await act(async () => { await view.refresh() })
  expect(events(records, firstLifetime)).toContainEqual(expect.objectContaining({ phase: 'read-started', attemptId: firstAttempt, operation: 'latest' }))
  expect(events(records, firstLifetime)).toContainEqual(expect.objectContaining({ phase: 'read-superseded', attemptId: firstAttempt, reason: 'navigation' }))
  await act(async () => dom.root.render(<Probe client={b.client} sessionId={b.session.agentSessionId} />))
  await wait(() => { expect(view.snapshot?.agentSessionId).toBe(b.session.agentSessionId); expect(view.loading).toBe(false); expect(view.inspect().dirty).toBe(false) })
  const secondLifetime = records.find(record => record.scope.agentSessionId === b.session.agentSessionId)!.scope.consumerId
  const secondBefore = events(records, secondLifetime).map(event => ({ ...event }))
  await act(async () => {
    release.resolve(); await pending
    for (const listener of listeners) listener({ hostId: 'local', agentSessionId: a.session.agentSessionId, sourceHostId: 'local',
      source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main' }, kind: 'invalidated' })
  })
  expect(events(records, firstLifetime)).toContainEqual(expect.objectContaining({ phase: 'read-ended', attemptId: firstAttempt, reason: 'cancelled' }))
  expect(events(records, secondLifetime), 'Late original work cannot emit under the replacement Session').toEqual(secondBefore)
  expect(records.filter(record => record.scope.consumerId === firstLifetime).every(record => record.scope.agentSessionId === a.session.agentSessionId)).toBe(true)
  expect(view.snapshot?.agentSessionId).toBe(b.session.agentSessionId)
  expect([...a.controls, ...b.controls].map(control => control.mock.calls.length)).toEqual(Array(12).fill(0))
})

it('keeps successful reads, observation and source changes usable when the diagnostic sink throws', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([native('original-input', 'kept-body')]))
  closes.push(f.close)
  const dom = setupDom(), sink = vi.fn(() => { throw new Error('private-diagnostic-save-failure') })
  const reporting = diagnostics([], sink)
  let view!: ReturnType<typeof useConversationView>
  function Probe() {
    view = useConversationView(f.client, { hostId: 'local', agentSessionId: f.session.agentSessionId }, true, { diagnostics: reporting })
    return <output>{view.snapshot?.units.length}</output>
  }
  await act(async () => dom.root.render(<Probe />))
  await wait(() => { expect(view.loading).toBe(false); expect(view.snapshot).not.toBeNull(); expect(view.inspect().watch.bound).toBe(true); expect(view.inspect().dirty).toBe(false) })
  await appendFile(f.path, jsonl([native('new-input', 'later-kept-body')]))
  await wait(() => expect(view.snapshot?.units.some(unit => unit.records.some(record => record.reference?.source.recordId === 'new-input'))).toBe(true))
  expect(sink).toHaveBeenCalled()
  expect(view.error).toBeNull(); expect(view.observationError).toBeNull()
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('publishes Activity visibility before reads settle and on exact reader changes', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([native('pending-first-input', 'private-pending-body')]))
  closes.push(f.close)
  const records: ReadingDiagnosticRecord[] = [], release = deferred<void>(), entered = deferred<void>()
  await capturePublications(f, records)
  const original = f.client.readAgentConversation.bind(f.client)
  const read = vi.spyOn(f.client, 'readAgentConversation').mockImplementation(async (input, options) => {
    entered.resolve(); await release.promise
    return original(input, options)
  })
  const changes = vi.spyOn(f.client, 'readConversationChanges'), observe = vi.spyOn(f.client, 'observeConversation')
  await desktopConversationReadBridge(f, closes)
  const dom = setupDom()
  closes.push(() => release.resolve())
  const props = activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })
  props.conversationReading!.consumer = { runId: f.session.run.runId, regionId: 'pending-original-region', presentationId: 'pending-original-presentation', visible: false, activityShown: true, viewMode: 'activity' }
  await act(async () => { dom.root.render(<ActivityView {...props} />) })
  await entered.promise
  await wait(() => expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'consumer-hidden', reason: 'hidden' })))
  expect(events(records).some(event => event.phase === 'consumer-visible')).toBe(false)
  props.conversationReading!.consumer = { ...props.conversationReading!.consumer!, visible: true }
  await act(async () => dom.root.render(<ActivityView {...props} />))
  await wait(() => {
    expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'consumer-visible' }))
    expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'read-started', operation: 'latest' }))
  })
  const sample = inspectConversationConsumers({ hostId: 'local', agentSessionId: f.session.agentSessionId }).consumers[0]!
  expect(sample).toMatchObject({ loading: true, inFlight: true, accepted: null })
  expect(events(records).some(event => ['assembly-complete', 'admission-accepted', 'dom-committed'].includes(event.phase)),
    'Actual visibility cannot invent a completed source or frame').toBe(false)
  expect([read.mock.calls.length, changes.mock.calls.length, observe.mock.calls.length],
    'Visibility evidence must not add another read or watch while the original read is pending').toEqual([1, 0, 0])
  expect(records.every(record => record.scope.agentSessionId === f.session.agentSessionId)).toBe(true)
  await act(async () => release.resolve())
  await wait(() => expect(dom.host.querySelector('[data-native-record-id="pending-first-input"]')).not.toBeNull())
  await wait(() => expect(events(records).some(event => event.phase === 'dom-committed')).toBe(true))
  const query = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  await wait(() => expect(inspectConversationConsumers(query).consumers[0]).toMatchObject({ loading: false, dirty: false }))
  const originalLifetimes = new Set(records.map(record => record.scope.consumerId))
  const nextRelease = deferred<void>(), nextEntered = deferred<void>()
  closes.push(() => nextRelease.resolve())
  read.mockImplementation(async (input, options) => { nextEntered.resolve(); await nextRelease.promise; return original(input, options) })
  const beforeSwitch = [read.mock.calls.length, changes.mock.calls.length, observe.mock.calls.length]
  await act(async () => dom.root.render(<ActivityView {...props}
    conversationReading={{ ...props.conversationReading!, identity: 'same-session-next-reading' }} />))
  await nextEntered.promise
  let nextLifetime: string | undefined
  await wait(() => {
    nextLifetime = records.find(record => !originalLifetimes.has(record.scope.consumerId))?.scope.consumerId
    expect(nextLifetime).toBeDefined()
    expect(events(records, nextLifetime)).toContainEqual(expect.objectContaining({ phase: 'consumer-visible' }))
  })
  expect(events(records, nextLifetime).some(event => event.phase === 'dom-committed')).toBe(false)
  expect(inspectConversationConsumers(query).consumers[0]).toMatchObject({ loading: true, inFlight: true, readingIdentity: 'same-session-next-reading' })
  expect([read.mock.calls.length, changes.mock.calls.length, observe.mock.calls.length]).toEqual([beforeSwitch[0]! + 1, beforeSwitch[1], beforeSwitch[2]])
  await act(async () => nextRelease.resolve())
  await wait(() => expect(inspectConversationConsumers(query).consumers[0]).toMatchObject({ loading: false, dirty: false }))
  const visibleCount = events(records, nextLifetime).filter(event => event.phase === 'consumer-visible').length
  await appendFile(f.path, jsonl([native('same-reader-update', 'private-update-body')]))
  await wait(() => expect(dom.host.querySelector('[data-native-record-id="same-reader-update"]')).not.toBeNull())
  await wait(() => expect(inspectConversationConsumers(query).consumers[0]).toMatchObject({ loading: false, dirty: false }))
  expect(events(records, nextLifetime).filter(event => event.phase === 'consumer-visible'),
    'A new frame cannot republish an unchanged visibility gate').toHaveLength(visibleCount)
  expect(JSON.stringify(records)).not.toContain('private-pending-body')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('publishes real Activity read, Range hold, release and DOM commit through the public source path without copying bodies', async () => {
  const f = await nativeHistoryFixture('claude', jsonl([tool('selected-tool')]))
  closes.push(f.close)
  const originalDrafts = useAppStore.getState().agentComposerDrafts
  const unsentDraft = 'Unsent original composer draft'
  useAppStore.setState({ agentComposerDrafts: { ...originalDrafts, [f.session.agentSessionId]: unsentDraft } })
  closes.push(() => { useAppStore.setState({ agentComposerDrafts: originalDrafts }) })
  const records: ReadingDiagnosticRecord[] = []
  const { publication, readRetained } = await capturePublications(f, records)
  await desktopConversationReadBridge(f, closes)
  const reads = [vi.spyOn(f.client, 'readAgentConversation'), vi.spyOn(f.client, 'readConversationChanges'), vi.spyOn(f.client, 'observeConversation')]
  const dom = setupDom()
  const originalDocument = { windowId: '17', documentGeneration: '1' }
  closes.push(registerWorkbenchDocument(dom.host.ownerDocument, originalDocument))
  const props = activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })
  props.conversationReading!.consumer = { runId: f.session.run.runId, regionId: 'original-region', presentationId: 'original-presentation', visible: true, parked: false, activityShown: true, viewMode: 'activity' }
  const query = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const current = () => inspectConversationConsumers(query).consumers[0]!
  const render = async (visible = true, enabled = true) => act(async () => dom.root.render(<ActivityView {...props}
    conversationReading={{ ...props.conversationReading!, enabled, consumer: { ...props.conversationReading!.consumer!, visible } }} />))
  await render()
  await wait(() => { expect(dom.host.querySelector('.wf-head')).not.toBeNull(); expect(current().loading).toBe(false); expect(current().dirty).toBe(false) })
  await wait(() => expect(events(records).some(event => event.phase === 'consumer-visible'), 'Initial visibility belongs to the live consumer lifetime').toBe(true))
  const firstFrame = current().accepted!
  const head = dom.host.querySelector('.wf-head')!, range = document.createRange()
  range.selectNodeContents(head); window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString()
  await appendFile(f.path, jsonl([tool('pending-tool')]))
  await wait(() => expect(current().held).toBe(true))
  const heldFrame = current().pending!
  expect(current().accepted!.revision).toBe(firstFrame.revision)
  expect(head.isConnected).toBe(true); expect(window.getSelection()!.toString()).toBe(selected)
  expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'admission-held', reason: 'native-reading-protection', windowId: heldFrame.id, windowRevision: heldFrame.revision }))
  expect(events(records).some(event => event.phase === 'dom-committed' && event.windowId === heldFrame.id && event.windowRevision === heldFrame.revision), 'A held frame cannot claim a DOM commit').toBe(false)
  await appendFile(f.path, jsonl([tool('still-held-tool')]))
  await wait(() => expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'read-deferred', reason: 'held' })))
  expect(current().pending!.revision, 'Publishing the reason cannot itself reread a protected window').toBe(heldFrame.revision)
  await act(async () => { window.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await wait(() => { expect(current().held).toBe(false); expect(current().accepted!.revision).toBeGreaterThanOrEqual(heldFrame.revision) })
  await wait(() => expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'dom-committed', windowId: heldFrame.id, windowRevision: heldFrame.revision })))
  expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'held-released', windowId: heldFrame.id, windowRevision: heldFrame.revision }))
  // Inject one real captured producer commit. Persistence alone would not emit
  // the Core watch notification exercised by this consumer chain.
  await Reflect.get(f.client, 'persistAndPublishTimeline').call(f.client, { type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'captured-only', agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Original submitted input', content: 'private-captured-body-marker', createdAt: 1, updatedAt: 1
  } }, { source: 'agentmux', observedAt: 1 }, 'local')
  await wait(() => expect(dom.host.querySelector('[data-submission-id="captured-only"]')).not.toBeNull())
  await wait(() => { expect(current().loading).toBe(false); expect(current().dirty).toBe(false) })
  await wait(() => {
    expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'invalidation-received', sourceKind: 'native' }))
    expect(events(records)).toContainEqual(expect.objectContaining({ phase: 'invalidation-received', sourceKind: 'captured' }))
  })
  const before = reads.map(read => read.mock.calls.length)
  await render(false)
  await wait(() => expect(events(records).some(event => event.phase === 'consumer-hidden')).toBe(true))
  await render(true)
  await wait(() => expect(events(records).filter(event => event.phase === 'consumer-visible').length).toBeGreaterThanOrEqual(2))
  expect(reads.map(read => read.mock.calls.length), 'Visibility diagnostics cannot read or rebind the source').toEqual(before)
  await render(false, false)
  await dom.unmount()
  await wait(() => expect(events(records).some(event => event.phase === 'consumer-ended')).toBe(true))
  expect(inspectConversationConsumers(query).consumers).toEqual([])
  const finalPublication = records.at(-1)!
  const retained = await readRetained()
  expect(retained.length, 'The ended consumer must remain discoverable without re-opening its view').toBeGreaterThan(0)
  expect(retained.some(record => record.report.reading?.logId === finalPublication.logId),
    'The common archive must retain the latest actual consumer checkpoint after unmount').toBe(true)
  expect(retained.flatMap(record => record.report.reading!.events)).toContainEqual(expect.objectContaining({ phase: 'consumer-ended' }))
  expect(retained).toContainEqual(expect.objectContaining({ producer: expect.objectContaining({ kind: 'renderer', windowId: '17', documentGeneration: '1' }),
    report: expect.objectContaining({ kind: 'conversation-reading-held', reading: expect.objectContaining({
      scope: expect.objectContaining({ agentSessionId: f.session.agentSessionId, runId: f.session.run.runId }) }) }) }))
  expect(retained.some(record => record.report.reading!.events.some(event => event.phase === 'admission-held' && event.reason === 'native-reading-protection'))).toBe(true)
  expect(retained.flatMap(record => record.report.reading!.events)).toContainEqual(expect.objectContaining({
    phase: 'dom-committed', document: originalDocument, regionId: 'original-region', presentationId: 'original-presentation'
  }))
  expect(reads.map(read => read.mock.calls.length), 'Retained public inspection cannot reopen or refresh the ended consumer').toEqual(before)
  expect(records.some(record => record.trigger === 'release' && record.endedAt !== null)).toBe(true)
  expect(publication).toHaveBeenCalled()
  const serialized = JSON.stringify(records)
  for (const forbidden of ['private-command-marker', 'private-captured-body-marker', 'checkpoint', 'nextCursor', 'transcriptPath', f.root]) expect(serialized).not.toContain(forbidden)
  expect(records.every(record => record.scope.consumerKind === 'conversation-pane' && record.scope.agentSessionId === f.session.agentSessionId)).toBe(true)
  expect(useAppStore.getState().agentComposerDrafts[f.session.agentSessionId]).toBe(unsentDraft)
  expect(f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
