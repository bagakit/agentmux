// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { expect, it, vi } from 'vitest'
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { composeOutboundMessage } from '@agentmux/core/agent-outbound-message'
import type { AgentSessionControl } from '../src/shared/contracts'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'

const BODY = 'Same native input body.'
const DECLARED_BODY = composeOutboundMessage({ amux: 'Original declared context.', user: BODY })
const DRAFT = 'Keep the unsent original draft.'
const SID = 'open-writer-conversation'
const row = (id: string, body = BODY) => JSON.stringify({ uuid: id, type: 'user', sessionId: 'native-open-writer', message: { role: 'user', content: body } }) + '\n'
type Read = ReturnType<typeof useSessionUserMessages>
let current: Read | undefined
function Conversation({ control, enabled }: { control: AgentSessionControl; enabled: boolean }) {
  const read = useSessionUserMessages(control, { enabled })
  useEffect(() => { current = read }, [read])
  return <ActivityView {...activityReadingProps({ control, visible: enabled })} nativeHistoryPage={read.nativeHistoryPage}
    displayState="working" />
}

it('held-open native writer reaches shared Conversation and preserves original nodes/Range/draft; hidden and unrelated files do not read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  const original = useAppStore.getState()
  const directory = await mkdtemp(join(tmpdir(), 'conversation-open-writer-'))
  const path = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  await writeFile(path, row('original', DECLARED_BODY))
  // The writer remains open across observation acquisition and every append.
  const writer = await open(path, 'a')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: SID, providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: directory, run: { runId: 'healthy-original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token', nativeHandle: { kind: 'provider', providerId: 'claude',
      sessionId: 'native-open-writer', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const before = await store.load()
  const client = new AgentMuxClient({ store })
  const bridgeCloses: Array<() => unknown | Promise<unknown>> = []
  await desktopConversationReadBridge({ root: directory, client }, bridgeCloses)
  const kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name)
    .mockImplementation(() => { throw new Error('Forbidden healthy Run control: ' + name) }))
  const windows = vi.spyOn(client, 'readAgentConversation'), changes = vi.spyOn(client, 'readConversationChanges')
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: SID, run: session.run! }
  useAppStore.setState({ timelines: {}, agentComposerDrafts: { [SID]: DRAFT } })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const render = async (enabled: boolean) => act(async () => root.render(<Conversation control={control} enabled={enabled} />))
  const wait = async (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    check()
  }, { timeout: 3000, interval: 10 })
  const ids = () => [...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(node => node.dataset.nativeRecordId)
  const references = (ids: readonly string[]) => ids.map(recordId => ({ hostId: 'local', agentSessionId: SID,
    source: { kind: 'native' as const, providerId: 'claude', nativeSessionId: 'native-open-writer', recordId } }))
  async function settledReaders(ids: readonly string[]) {
    await wait(() => {
      expect(current?.nativeHistoryPage?.items.map(item => item.id)).toEqual(ids)
      const summary = current!.conversation.inspect()
      const activities = inspectConversationConsumers({ hostId: 'local', agentSessionId: SID, records: references(ids) }).consumers
      expect(activities).toHaveLength(1)
      for (const reader of [summary, activities[0]!]) expect(reader).toMatchObject({ loading: false, inFlight: false, dirty: false,
        held: false, error: null, sourceError: null, observationError: null, watch: { binding: false, bound: true, closed: false } })
      expect(activities[0]!.accepted).toMatchObject({ recordCount: ids.length,
        membership: references(ids).map(record => ({ record, present: true })) })
    })
    return { summary: current!.conversation.inspect(), activity: inspectConversationConsumers(control).consumers[0]! }
  }
  const readCounts = () => ({ windows: windows.mock.calls.length, changes: changes.mock.calls.length })
  try {
    await render(true)
    await wait(() => expect(ids()).toEqual(['original']))
    const initialReaders = await settledReaders(['original'])
    // Input summary and Activity own two distinct accepted Core windows. Their
    // source-qualified Reader ports do not call the old public history method.
    expect(windows).toHaveBeenCalledTimes(2)
    const initialPages = await Promise.all(windows.mock.results.map(result => {
      expect(result.type).toBe('return')
      if (result.type !== 'return') throw new Error('The original public window did not return its page')
      return result.value
    }))
    expect(new Set(initialPages.map(page => page.window.id))).toEqual(new Set([initialReaders.summary.snapshot!.window.id, initialReaders.activity.accepted!.id]))
    expect(new Set(initialPages.map(page => page.window.id)).size).toBe(2)
    for (const [input] of windows.mock.calls) expect(input).toMatchObject({ hostId: 'local', agentSessionId: SID })
    for (const page of initialPages) {
      expect(page.window.complete).toBe(true)
      expect(page.scope.sources.filter(source => source.kind === 'native')).toEqual([{ kind: 'native', providerId: 'claude', nativeSessionId: 'native-open-writer' }])
      expect(page.items.flatMap(entry => entry.kind === 'item' ? entry.item.records.map(record => record.reference) : [])).toEqual(references(['original']))
    }
    const initialReads = readCounts()
    expect(current?.observationError).toBeNull()
    const body = host.querySelector<HTMLElement>('[data-native-record-id="original"] .log-turn__body p')!
    expect(body.textContent).toBe(BODY)
    const context = host.querySelector<HTMLDetailsElement>('[data-native-record-id="original"] .log-turn__declared-context')!
    expect(context).not.toBeNull(); context.open = true
    expect(context.open).toBe(true)
    expect(context.querySelector('pre')?.textContent).toContain('Original declared context.')
    const range = document.createRange(); range.selectNodeContents(body)
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    const feed = host.querySelector<HTMLElement>('.activity-feed')!; feed.scrollTop = 24
    await writer.write(row('same-body', DECLARED_BODY) + row('latest', '这条也不会')); await writer.sync()
    await wait(() => expect(ids()).toEqual(['original', 'same-body', 'latest']))
    const appendedReaders = await settledReaders(['original', 'same-body', 'latest'])
    expect(appendedReaders.activity.consumerId).toBe(initialReaders.activity.consumerId)
    expect(appendedReaders.summary.watch.invalidations).toBeGreaterThan(initialReaders.summary.watch.invalidations)
    expect(appendedReaders.activity.watch.invalidations).toBeGreaterThan(initialReaders.activity.watch.invalidations)
    expect(windows).toHaveBeenCalledTimes(initialReads.windows)
    expect(changes.mock.calls.length).toBeGreaterThan(initialReads.changes)
    for (const [input] of changes.mock.calls) expect(input).toMatchObject({ hostId: 'local', agentSessionId: SID })
    expect(current?.messages.map(message => [message.rawId, message.author.kind, message.recordedAt])).toEqual([
      ['original', 'unknown', undefined], ['same-body', 'unknown', undefined], ['latest', 'unknown', undefined]
    ])
    expect(host.querySelector('[data-native-record-id="latest"]')?.textContent).toContain('这条也不会')
    expect(host.querySelector('[data-native-record-id="original"] .log-turn__body p')).toBe(body)
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(body)
    expect(feed.scrollTop).toBe(24); expect(current?.windowFrozen).toBe(false)
    expect(host.querySelector('[data-native-record-id="original"] .log-turn__declared-context')).toBe(context)
    expect(context.open).toBe(true)
    const settledReads = readCounts()
    await writeFile(join(directory, 'unrelated.jsonl'), row('unrelated', 'Actual unrelated native bytes.'))
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
    expect(readCounts()).toEqual(settledReads)
    await render(false)
    await wait(() => {
      expect(current!.conversation.inspect()).toMatchObject({ loading: false, inFlight: false, watch: { binding: false, bound: false } })
      expect(inspectConversationConsumers(control).consumers[0]).toMatchObject({ loading: false, inFlight: false, watch: { binding: false, bound: false } })
    })
    const hiddenReads = readCounts()
    await writer.write(row('hidden')); await writer.sync()
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
    expect(readCounts()).toEqual(hiddenReads)
    expect(ids()).toEqual(['original', 'same-body', 'latest'])
    expect(body.isConnected).toBe(true)
    await render(true)
    await wait(() => expect(ids()).toEqual(['original', 'same-body', 'latest', 'hidden']))
    await settledReaders(['original', 'same-body', 'latest', 'hidden'])
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(body)
    expect(host.querySelector('[data-native-record-id="original"] .log-turn__body p')).toBe(body)
    expect(context.open).toBe(true); expect(context.isConnected).toBe(true)
    expect(useAppStore.getState().agentComposerDrafts[SID]).toBe(DRAFT)
    expect(await store.load()).toEqual(before)
    expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(path, 'utf8')).toBe(row('original', DECLARED_BODY) + row('same-body', DECLARED_BODY) + row('latest', '这条也不会') + row('hidden'))
  } finally {
    await act(async () => root.unmount()); host.remove(); document.getSelection()?.removeAllRanges()
    await writer.close()
    for (const close of bridgeCloses.reverse()) await close()
    await client.dispose(); await rm(directory, { recursive: true })
    useAppStore.setState(original, true); current = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
