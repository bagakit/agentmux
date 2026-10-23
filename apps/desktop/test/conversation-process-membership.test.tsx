// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { writeFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { conversationRecordId } from '../../../packages/core/src/conversation'
import type { ConversationConsumerQuery } from '../../../packages/core/src/conversation-consumer-query'
import type { DesktopControlRequest } from '../src/shared/contracts'
import { desktopConversationConsumerObservationSchema } from '../src/shared/conversation-consumer-observation'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { inspectDesktopClient } from '../src/main/client-observation'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
import { conversationReadingAnchor, restoreConversationAnchor } from '../../../packages/client-ui/src/lib/conversation-reading-anchor'
import type { ConversationProcessMember } from '../../../packages/client-ui/src/components/ConversationRecordSequence'
import { useAppStore } from '../src/renderer/src/store'
import { activityReadingProps } from './helpers/activity-reading-props'
import { createClientUiRoot } from './helpers/client-ui-render'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { window.getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const wait = (assertion: () => unknown | Promise<unknown>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); await assertion() }, { timeout: 10000, interval: 20 })
const bounds = (top: number, height: number, width = 500) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: width, width, height, toJSON() {} })
class VisibleObserver {
  static all: VisibleObserver[] = []
  targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) { VisibleObserver.all.push(this) }
  observe(node: Element) { this.targets.add(node) }
  unobserve(node: Element) { this.targets.delete(node) }
  disconnect() { this.targets.clear() }
  show(node: Element) {
    expect(this.targets.has(node)).toBe(true)
    this.callback([...this.targets].map(target => ({ target, isIntersecting: target === node }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
  }
}
async function fixture(mixed: boolean) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); VisibleObserver.all = []
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', VisibleObserver)
  const native = { type: 'assistant', uuid: 'shared', sessionId: 'native-main', timestamp: new Date(fixtureEpoch(0, 0, 1)).toISOString(),
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'original-call', name: 'shell', input: { command: 'pwd' } }] } }
  const f = await nativeHistoryFixture('claude', jsonl(mixed ? [native] : [])); closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'shared', agentSessionId: f.session.agentSessionId, kind: 'tool_call', source: 'agentmux', status: 'complete',
    title: 'Original captured tool', toolName: 'recorded-tool', toolInput: '{"original":true}', createdAt: fixtureEpoch(0, 0, 2), updatedAt: fixtureEpoch(0, 0, 2)
  } })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: {
    id: 'neighbor-input', agentSessionId: f.session.agentSessionId, kind: 'user_message', source: 'user', status: 'complete',
    title: 'Separate input', content: 'Neighbor original input', createdAt: fixtureEpoch(0, 0, 3), updatedAt: fixtureEpoch(0, 0, 3)
  } })
  await desktopConversationReadBridge(f, closes)
  const reads = [vi.spyOn(f.client, 'readAgentConversation'), vi.spyOn(f.client, 'readConversationChanges'), vi.spyOn(f.client, 'observeConversation')]
  let deliver!: (request: DesktopControlRequest) => void
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: request => deliver(request), sendCancellation: () => {} })
  const rendererControl = createRendererControlApi({ onRequest: listener => { deliver = listener; return () => {} }, onCancellation: () => () => {}, respond: response => bridge.accept(response) })
  closes.push(rendererControl.onRequest((request, signal) => useAppStore.getState().executeControl(request as never, signal)))
  const renderer = { kind: 'bundled' as const, id: 'a'.repeat(64), identity: { shell: 'original-shell', ctxmux: 'original-runtime' } }
  const server = new AgentMuxControlServer({ coreClients: () => [], execute: request => inspectDesktopClient(request, {
    pid: 81, package: null, renderer: () => renderer, generation: () => 1, runtimes: () => [], execute: request => bridge.execute(request)
  }) }, join(f.root, 'process-members.sock'))
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const props = activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run }, workspaceRoot: f.root })
  props.conversationReading!.consumer = { runId: f.session.run.runId, regionId: 'original-process-region', presentationId: 'original-process-presentation', visible: true, activityShown: true, viewMode: 'activity' }
  const captured = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'captured' as const, recordId: 'shared' } }
  const nativeRef = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-main', recordId: 'shared' } }
  const query: ConversationConsumerQuery = { hostId: 'local', agentSessionId: f.session.agentSessionId, expectedRunId: f.session.run.runId,
    records: [captured, ...(mixed ? [nativeRef] : []), { ...captured, hostId: 'other-host' },
      { ...captured, hostId: 'other-host', source: { kind: 'captured', recordId: 'neighbor-input' } }] }
  const inspect = async (input = query) => desktopConversationConsumerObservationSchema.parse((await rpc.call('app.inspect', { conversation: input })).observation)
  await act(async () => root.render(<ActivityView {...props} />))
  await wait(async () => { expect(host.querySelector('.wf-head')).not.toBeNull(); expect((await inspect()).consumers[0]?.loading).toBe(false) })
  return { f, host, inspect, query, reads, socket: server.path }
}

it.each([false, true])('keeps unopened %s process members on the ruler, shared anchor and public original consumer', async mixed => {
  const x = await fixture(mixed), group = x.host.querySelector<HTMLElement>('[data-conversation-process-members]')!, head = group.querySelector<HTMLElement>('.wf-head')!
  expect(head.getAttribute('aria-expanded')).toBe('false')
  expect(group.querySelector('[data-captured-process-id]'), 'Unopened original bodies must remain unmounted').toBeNull()
  expect(group.hasAttribute('data-native-record-ids')).toBe(false)
  const members = JSON.parse(group.dataset.conversationProcessMembers!) as ConversationProcessMember[]
  expect(members).toHaveLength(mixed ? 2 : 1)
  const sourceIds = members.flatMap(member => member.sources.map(conversationRecordId))
  expect(sourceIds).toEqual(expect.arrayContaining(x.query.records!.slice(0, mixed ? 2 : 1).map(conversationRecordId)))
  expect(sourceIds).not.toContain(conversationRecordId(x.query.records!.at(-1)!))
  const sample = (await x.inspect()).consumers[0]!
  expect(sample.location.regionId).toBe('original-process-region')
  expect(sample.accepted!.membership.map(member => member.present)).toEqual(mixed ? [true, true, false, false] : [true, false, false])
  expect(sample.rendered.map(member => member.process)).toEqual(mixed ? [true, true, false, false] : [true, false, false])
  expect(sample.rendered.at(-1), 'Same raw input from another original Host cannot borrow this mounted disclosure').toMatchObject({ message: false, disclosure: false })
  expect((await x.inspect({ ...x.query, consumerId: sample.consumerId })).consumers).toHaveLength(1)
  if (mixed) {
    const input = join(x.f.root, 'original-process-query.json'), exact = { ...x.query, consumerId: sample.consumerId }
    await writeFile(input, JSON.stringify({ conversation: exact }))
    const cli = join(process.cwd(), 'packages/core/dist/agentmux.js')
    expect(await realpath(cli), 'CLI must consume this checkout\'s built entry').toBe(cli)
    const env = { ...process.env }; delete env.AGENTMUX_AGENT_SESSION_ID; delete env.AGENTMUX_AGENT_CAPABILITY
    const { stdout } = await promisify(execFile)(process.execPath, [cli, '--endpoint', `unix:${x.socket}`, 'app', 'inspect', '--input', input], { env })
    const receipt = JSON.parse(stdout); expect(receipt.ok).toBe(true)
    const original = desktopConversationConsumerObservationSchema.parse(receipt.result.observation)
    expect(original.query).toEqual(exact); expect(original.consumers).toHaveLength(1)
    expect(original.consumers[0]!.location.regionId).toBe('original-process-region')
    expect(original.consumers[0]!.rendered.map(member => member.process)).toEqual([true, true, false, false])
  }
  expect((await x.inspect({ ...x.query, agentSessionId: 'other-session' })).consumers).toEqual([])
  const observer = VisibleObserver.all.find(observer => observer.targets.has(head))!
  expect(observer, 'Original ruler must observe pure captured folded headers').toBeDefined()
  await act(async () => observer.show(head))
  expect(x.host.querySelector('.activity-ruler__band')).not.toBeNull()
  const feed = x.host.querySelector<HTMLElement>('.activity-feed')!
  feed.getBoundingClientRect = () => bounds(0, 500); group.getBoundingClientRect = () => bounds(100, 30); head.getBoundingClientRect = () => bounds(100, 30)
  const anchor = conversationReadingAnchor(feed, undefined, false, [head])
  expect(anchor).toMatchObject({ kind: 'group', offset: 100 })
  head.getBoundingClientRect = () => bounds(175, 30)
  restoreConversationAnchor(feed, anchor!); expect(feed.scrollTop).toBe(75)
  const before = x.reads.map(read => read.mock.calls.length)
  expect(inspectConversationConsumers(x.query).consumers).toHaveLength(1)
  expect(x.reads.map(read => read.mock.calls.length), 'The original mounted observation callback cannot issue another read').toEqual(before)
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('a real ruler click reveals the exact previously unmounted and read-then-collapsed captured step without selecting its native neighbor', async () => {
  const x = await fixture(true), group = x.host.querySelector<HTMLElement>('[data-conversation-process-members]')!
  const track = x.host.querySelector<HTMLElement>('.activity-ruler__track')!
  track.getBoundingClientRect = () => bounds(0, 24, 1000)
  const scrolled: Element[] = []
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this) })
  const reveal = async () => {
    await act(async () => track.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 500 })))
    await wait(() => {
      expect(group.querySelector('.wf-head')!.getAttribute('aria-expanded')).toBe('true')
      const row = group.querySelector<HTMLElement>('[data-captured-process-id="shared"]')!
      expect(row).not.toBeNull(); expect(row.querySelector('.wf-tool-row')!.getAttribute('aria-expanded')).toBe('true')
      expect(row.querySelector('pre')?.textContent).toBe('{"original":true}')
      expect(scrolled.at(-1)?.querySelector('[data-captured-process-id="shared"]')).toBe(row)
    })
  }
  await reveal()
  expect(group.querySelector('[data-native-step-id="shared"] .wf-tool-row')?.getAttribute('aria-expanded')).toBe('false')
  await act(async () => group.querySelector<HTMLButtonElement>('.wf-head')!.click())
  expect(group.querySelector('.wf-head')!.getAttribute('aria-expanded')).toBe('false')
  await reveal()
  expect((await x.inspect()).consumers[0]!.rendered.map(member => member.process)).toEqual([true, true, false, false])
  expect(x.f.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})
