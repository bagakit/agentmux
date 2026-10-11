// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, useLayoutEffect } from 'react'
import { appendFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseAgentMuxControlRequest } from '../../../packages/core/src/control-codec'
import { parseConversationConsumerQuery, type ConversationConsumerQuery } from '../../../packages/core/src/conversation-consumer-query'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import type { AgentTimelineItem } from '../../../packages/core/src/types'
import type { DesktopControlRequest } from '../src/shared/contracts'
import { desktopConversationConsumerObservationSchema } from '../src/shared/conversation-consumer-observation'
import { parseDesktopClientObservation } from '../src/shared/client-observation'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { inspectDesktopClient } from '../src/main/client-observation'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { activityReadingProps } from './helpers/activity-reading-props'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useConversationView } from '../../../packages/client-ui/src/lib/use-conversation-view'
import { ConversationView } from '../../../packages/client-ui/src/components/ConversationView'
import { projectConversationReading } from '../../../packages/client-ui/src/lib/conversation-records'
import { conversationRenderedObservation } from '../src/renderer/src/lib/conversation-consumer-observation'
import { registerWorkbenchDocument } from '../src/renderer/src/lib/workbench-window-registry'

const closes: Array<() => unknown | Promise<unknown>> = []
const initial = useAppStore.getState()
afterEach(async () => {
  getSelection()?.removeAllRanges()
  for (const close of closes.splice(0).reverse()) await close()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const flush = (assertion: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); await assertion() }, { timeout: 10000 })
const packageIdentity = { schema: 'agentmux.package-identity.v1', sourceCommit: 'qualified-source', sourceTree: 'qualified-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' } as const
const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'qualified-shell', ctxmux: 'retained-runtime' } } as const
const native = (id: string, content: string) => ({ type: 'user', uuid: id, sessionId: 'native-main', message: { role: 'user', content } })
const tool = (id: string) => ({ type: 'assistant', uuid: id, sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-' + id, name: 'shell', input: { command: 'pwd' } }] } })

async function fixture(rows = [native('native-input', 'Source text is not an identity')]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  const f = await nativeHistoryFixture('claude', jsonl(rows)); closes.push(f.close)
  await desktopConversationReadBridge(f, closes)
  const reads = [vi.spyOn(f.client, 'readAgentConversation'), vi.spyOn(f.client, 'readConversationChanges'), vi.spyOn(f.client, 'observeConversation')]
  let deliver!: (request: DesktopControlRequest) => void
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: request => deliver(request), sendCancellation: () => {} })
  const fallback = vi.fn((request: DesktopControlRequest, signal: AbortSignal) => useAppStore.getState().executeControl(request as never, signal))
  const control = createRendererControlApi({ onRequest: listener => { deliver = listener; return () => {} },
    onCancellation: () => () => {}, respond: response => bridge.accept(response) })
  closes.push(control.onRequest(fallback))
  const socket = join(f.root, 'consumer-inspection.sock')
  let generation = 7
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: request => inspectDesktopClient(request, {
    pid: 123, package: packageIdentity, renderer: () => renderer, generation: () => generation,
    runtimes: () => [], execute: request => bridge.execute(request)
  }) }, socket)
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }); closes.push(() => rpc.dispose())
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const props = activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })
  props.conversationReading!.consumer = { runId: f.session.run.runId, regionId: 'original-region', presentationId: 'original-presentation', visible: true, parked: false, activityShown: true, viewMode: 'activity' }
  const query: ConversationConsumerQuery = { hostId: 'local', agentSessionId: f.session.agentSessionId, expectedRunId: f.session.run.runId,
    records: [{ hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native', providerId: 'claude', nativeSessionId: 'native-main', recordId: 'native-input' } },
      { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'captured', recordId: 'captured-input' } }] }
  const inspect = async (value = query) => desktopConversationConsumerObservationSchema.parse((await rpc.call('app.inspect', { conversation: value })).observation)
  const render = async (visible = true) => {
    host.hidden = !visible
    await act(async () => root.render(<ActivityView {...props} conversationReading={{ ...props.conversationReading!, enabled: visible,
      consumer: { ...props.conversationReading!.consumer!, visible } }} />))
  }
  return { f, reads, fallback, rpc, socket, host, root, props, query, inspect, render, setGeneration: (value: number) => { generation = value } }
}
function count(reads: readonly { mock: { calls: readonly unknown[] } }[]) { return reads.map(read => read.mock.calls.length) }

it('observes exact accepted source membership and actual cards through public RPC/Main/Renderer without another reader', async () => {
  const x = await fixture()
  const item: AgentTimelineItem = { id: 'captured-input', agentSessionId: x.f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete', title: 'Original submitted input', content: 'Source text is not an identity', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) }
  await x.f.store.applyTimelineMutation({ type: 'append', agentSessionId: x.f.session.agentSessionId, item })
  expect((await x.inspect()).consumers, 'Inspection cannot mount an absent consumer').toEqual([])
  await x.render()
  await flush(() => expect(x.host.querySelector('[data-native-record-id="native-input"]')).not.toBeNull())
  let sample = (await x.inspect()).consumers[0]!
  expect(sample, 'Expected the mounted exact reader').toBeDefined()
  await flush(() => expect(sample.watch.bound).toBe(true))
  const before = count(x.reads)
  sample = (await x.inspect()).consumers[0]!
  expect(sample, 'Expected the mounted exact reader').toBeDefined()
  expect(sample.runId).toBe(x.f.session.run.runId); expect(sample.matchesExpectedRun).toBe(true)
  expect(sample.location).toEqual({ regionId: 'original-region', presentationId: 'original-presentation', document: null })
  expect(sample.accepted!.membership.map(value => value.present), 'Source-qualified originals must belong to the accepted frame').toEqual([true, true])
  expect(sample.rendered.map(value => value.message), 'The native card and collapsed independent submission must remain distinct').toEqual([true, false])
  expect(sample.rendered.map(value => [value.disclosure, value.open])).toEqual([[false, null], [true, false]])
  expect(JSON.stringify(sample)).not.toContain('Source text is not an identity')
  expect(sample.pending).toBeNull(); expect(sample.error).toBeNull()
  expect(count(x.reads), 'Inspecting cannot read, observe or refresh a source').toEqual(before)
  await act(async () => { const details = x.host.querySelector<HTMLDetailsElement>('[data-submission-id="captured-input"] details')!; details.open = true; details.dispatchEvent(new Event('toggle')) })
  const opened = (await x.inspect()).consumers[0]!
  expect(opened.rendered.map(value => value.message)).toEqual([true, true]); expect(opened.rendered[1]!.open).toBe(true)
  expect(opened.rendered.map(value => value.messageExposed)).toEqual([true, true])
  await act(async () => { const details = x.host.querySelector<HTMLDetailsElement>('[data-submission-id="captured-input"] details')!; details.open = false; details.dispatchEvent(new Event('toggle')) })
  const closed = (await x.inspect()).consumers[0]!
  expect(closed.rendered[1]!.message, 'Closing retains the original mounted card').toBe(true)
  expect(closed.rendered[1]!.messageExposed, 'A hidden retained card is not exposed').toBe(false)
  expect(closed.rendered[1]!.open).toBe(false)
  const adopted = document.implementation.createHTMLDocument('Original workface')
  const documentIdentity = { windowId: 'original-window', documentGeneration: 'original-generation' }
  closes.push(registerWorkbenchDocument(adopted, documentIdentity))
  adopted.body.append(x.host)
  expect((await x.inspect()).consumers[0]!.location.document, 'Location follows the actual adopted DOM document').toEqual(documentIdentity)
  expect(count(x.reads)).toEqual(before)
  document.body.append(x.host)
  expect(x.f.controls.map(value => value.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
  const wrong = await x.inspect({ ...x.query, expectedRunId: 'another-run', records: x.query.records!.map(record => ({ ...record, hostId: 'another-host' })) })
  expect(wrong.consumers[0]!.matchesExpectedRun).toBe(false)
  expect(wrong.consumers[0]!.accepted!.membership.map(value => value.present)).toEqual([false, false])
  expect(wrong.consumers[0]!.rendered.map(value => value.message)).toEqual([false, false])
  expect((await x.inspect({ ...x.query, agentSessionId: 'another-session' })).consumers).toEqual([])
  expect((await x.inspect({ ...x.query, consumerId: 'another-consumer' })).consumers).toEqual([])
  expect(x.f.session.run.runId).toBe(sample.runId)
})

it('reports unopened original-contribution disclosures without attributing their parent card', async () => {
  const x = await fixture(), sid = x.f.session.agentSessionId
  const source = { providerId: 'claude', nativeSessionId: 'native-main' }
  const reference = (recordId: string) => ({ hostId: 'local', agentSessionId: sid, source: { kind: 'native' as const, ...source, recordId } })
  const page = { agentSessionId: sid, sourceHostId: 'local', source, nextCursor: null, items: [
    { id: 'a', kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text: 'First contribution' }], conversation: { sameEvent: reference('b') } },
    { id: 'b', kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text: 'Second contribution' }] }
  ] }
  const projection = projectConversationReading({ agentSessionId: sid, executionHostId: 'local', historyPage: page })
  await act(async () => x.root.render(<ConversationView sessionId={sid} executionHostId="local" page={page} records={projection.records} originalRecords={projection.originalRecords} coverage={projection.timeline.coverage} />))
  const details = x.host.querySelector<HTMLDetailsElement>('.conversation-original-record')!
  expect(details).not.toBeNull()
  const record = reference(JSON.parse(details.dataset.messageSourceKey!).at(-1))
  let sample = conversationRenderedObservation(x.host, sid, [record], 'local')[0]!
  expect(sample.message).toBe(false); expect(sample.messageExposed).toBe(false)
  expect(sample.disclosure).toBe(true); expect(sample.open).toBe(false)
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  sample = conversationRenderedObservation(x.host, sid, [record], 'local')[0]!
  expect(sample.message).toBe(true); expect(sample.messageExposed).toBe(true)
  await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')) })
  sample = conversationRenderedObservation(x.host, sid, [record], 'local')[0]!
  expect(sample.message).toBe(true); expect(sample.messageExposed).toBe(false); expect(sample.open).toBe(false)
})

it('applies the displayed reference fence to committed inspection after a Session switch', async () => {
  const x = await fixture()
  let view!: ReturnType<typeof useConversationView>, sampled!: ReturnType<ReturnType<typeof useConversationView>['inspect']>
  function Probe({ sessionId, active }: { sessionId: string; active: boolean }) {
    view = useConversationView(x.f.client, { hostId: 'local', agentSessionId: sessionId }, active)
    useLayoutEffect(() => { sampled = view.inspect() })
    return null
  }
  await act(async () => x.root.render(<Probe sessionId={x.f.session.agentSessionId} active />))
  await flush(() => expect(view.snapshot).not.toBeNull())
  await act(async () => x.root.render(<Probe sessionId="another-session" active={false} />))
  expect(view.snapshot).toBeNull(); expect(sampled.snapshot).toBeNull()
  expect(sampled.watch.bound).toBe(false); expect(sampled.pending).toBeNull()
})

it('separates the accepted frame, held original checkpoint and unchanged selected process DOM', async () => {
  const x = await fixture([tool('selected-tool') as never]); await x.render()
  await flush(() => expect(x.host.querySelector('.wf-head')).not.toBeNull())
  const head = x.host.querySelector('.wf-head')!, range = document.createRange()
  range.selectNodeContents(head); getSelection()!.addRange(range)
  const old = (await x.inspect()).consumers[0]!.accepted!
  await appendFile(x.f.path, jsonl([tool('pending-tool')]))
  let sample = (await x.inspect()).consumers[0]!
  await flush(async () => { sample = (await x.inspect()).consumers[0]!; expect(sample.held).toBe(true) })
  expect(sample.accepted!.id).toBe(old.id); expect(sample.accepted!.revision).toBe(old.revision)
  expect(sample.pending, 'A held consumer must expose the pending original frame separately').not.toBeNull()
  expect(sample.pending!.id).toBe(old.id); expect(sample.pending!.revision).toBeGreaterThan(old.revision)
  const pendingRef = { ...x.query.records![0]!, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'pending-tool' } }
  const before = count(x.reads), observed = (await x.inspect({ ...x.query, records: [pendingRef] })).consumers[0]!
  expect(observed.accepted!.membership[0]!.present).toBe(false); expect(observed.pending!.membership[0]!.present).toBe(true)
  expect(getSelection()!.getRangeAt(0).startContainer.isConnected).toBe(true); expect(head.isConnected).toBe(true)
  expect(count(x.reads)).toEqual(before)
  await act(async () => { getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  await flush(async () => { sample = (await x.inspect({ ...x.query, records: [pendingRef] })).consumers[0]!; expect(sample.held).toBe(false); expect(sample.accepted!.membership[0]!.present).toBe(true) })
  expect(sample.pending).toBeNull()
})

it('takes the ref, Run and gate from the real SessionPane consumer rather than the current selection', async () => {
  const x = await fixture()
  const agent = { ...composerSession(x.f.session.agentSessionId, 'claude'), workspacePath: x.f.root,
    nativeHandle: x.f.session.nativeHandle!, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: x.f.session.agentSessionId, run: x.f.session.run } }
  useAppStore.setState({ config: composerConfig, sessions: [agent], timelines: {}, viewModes: { [agent.id]: 'activity' },
    agentComposerDrafts: { [agent.id]: 'Original unsent draft' }, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [] })
  const render = async (visible: boolean) => act(async () => x.root.render(<SessionPane sessionId={agent.id} surfaceKind="agent" interactiveResize={false} visible={visible} readOnly
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} />))
  await render(true)
  await flush(() => expect(x.host.querySelector('[data-native-record-id="native-input"]')).not.toBeNull())
  let sample = (await x.inspect()).consumers[0]!
  expect(sample.reference).toEqual({ hostId: 'local', agentSessionId: agent.id })
  expect(sample.runId).toBe(x.f.session.run.runId); expect(sample.location.regionId).toBe('original-region')
  expect(sample.gates).toEqual({ enabled: true, visible: true, parked: false, activityShown: true, viewMode: 'activity' })
  await render(false)
  sample = (await x.inspect()).consumers[0]!
  expect(sample.gates).toEqual({ enabled: false, visible: false, parked: false, activityShown: true, viewMode: 'activity' })
  expect(sample.runId).toBe(x.f.session.run.runId)
  expect(useAppStore.getState().agentComposerDrafts[agent.id]).toBe('Original unsent draft')
  expect(x.f.controls.map(value => value.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('keeps hidden and unmounted consumers distinct from unavailable Sessions and preserves the no-query inspector', async () => {
  const x = await fixture(); await x.render()
  await flush(() => expect(x.host.querySelector('[data-native-record-id="native-input"]')).not.toBeNull())
  await x.render(false)
  const before = count(x.reads), sample = (await x.inspect()).consumers[0]!
  expect(sample.gates.enabled).toBe(false); expect(sample.gates.visible).toBe(false)
  expect(sample.watch.bound).toBe(false); expect(sample.viewport.hidden).toBe(true)
  expect(sample.accepted!.membership[0]!.present).toBe(true)
  expect(count(x.reads)).toEqual(before)
  const old = parseDesktopClientObservation((await x.rpc.call('app.inspect', {})).observation)
  expect(old.schema).toBe('agentmux.desktop-client-observation.v1'); expect(x.fallback).toHaveBeenCalledTimes(1)
  expect(old.main.renderer).toEqual(renderer)
  await act(async () => x.root.render(null))
  expect((await x.inspect()).consumers).toEqual([]); expect(count(x.reads)).toEqual(before)
})

it('carries the optional exact query through the compiled CLI and keeps effect-like parameters invalid', async () => {
  const x = await fixture(); await x.render()
  await flush(() => expect(x.host.querySelector('[data-native-record-id="native-input"]')).not.toBeNull())
  const input = join(x.f.root, 'inspection.json'); await writeFile(input, JSON.stringify({ conversation: x.query }))
  const env = { ...process.env }; delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
  const cli = process.env.AGENTMUX_CONSUMER_OBSERVATION_CLI ?? fileURLToPath(new URL('../../../packages/core/dist/agentmux.js', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [cli!, '--endpoint', `unix:${x.socket}`, 'app', 'inspect', '--input', input], { env })
  const receipt = JSON.parse(stdout)
  expect(receipt.ok).toBe(true)
  const observation = desktopConversationConsumerObservationSchema.parse(receipt.result.observation)
  expect(observation.consumers[0]!.accepted!.membership[0]!.present).toBe(true)
  expect(observation.main.documentGeneration).toBe(7)
  const { stdout: help } = await promisify(execFile)(process.execPath, [cli!, 'app', 'inspect', '--help'], { env })
  expect(help).toContain('--input'); expect(help).toContain('already-mounted readers')
  for (const extra of [{ focus: true }, { retry: true }, { text: 'do not accept bodies' }])
    expect(() => parseConversationConsumerQuery({ ...x.query, ...extra })).toThrow(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
  expect(() => parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'query-effects', operation: 'inspect.client', conversation: x.query, activate: true })).toThrow()
  expect(x.f.controls.map(value => value.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
