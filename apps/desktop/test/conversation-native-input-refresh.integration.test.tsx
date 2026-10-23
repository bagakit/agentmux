import { fixtureIso as _hygiene_fixtureIso } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { AgentProvider, AgentSessionHistoryPage, AgentSessionHistoryPageOptions, AgentSessionHistorySource, AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => createElement('output', { 'data-terminal-leaf': 'isolated' }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import * as conversationView from '@agentmux/client-ui/use-conversation-view'

const NOW = Date.parse(_hygiene_fixtureIso(23882400000, "second"))
const A = 'native-refresh-a', C = 'native-refresh-unrelated-c'
const baseline = useAppStore.getState()
const roots: Root[] = [], nodes: HTMLElement[] = [], cleanups: (() => Promise<void>)[] = []
type Read = ReturnType<typeof useSessionUserMessages>
let current: Read | undefined
function Conversation({ control, enabled = true }: { control: AgentSessionControl; enabled?: boolean }) {
  const read = useSessionUserMessages(control, { enabled })
  useEffect(() => { current = read }, [read])
  return <ActivityView {...activityReadingProps({ control, visible: enabled })} displayState="done" />
}
afterEach(async () => {
  const failures: unknown[] = []
  const actions: Array<() => unknown | Promise<unknown>> = [
    ...roots.splice(0).map(root => () => act(async () => root.unmount())),
    ...nodes.splice(0).map(node => () => node.remove()), ...cleanups.splice(0),
    () => useAppStore.setState(baseline, true), () => vi.restoreAllMocks(), () => vi.unstubAllGlobals(), () => vi.useRealTimers(),
    () => { current = undefined }, () => document.getElementById('agentmux-window-overlay-host')?.remove()
  ]
  for (const close of actions) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Native input refresh cleanup failed')
})
function hasNativeObservation(provider: AgentProvider): provider is AgentProvider & Required<Pick<AgentProvider, 'observeSessionHistory'>> {
  return typeof provider.observeSessionHistory === 'function'
}
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
function row(provider: 'claude' | 'pi', id: string, parent: string | null, timed = true, text = 'Identical native body.') {
  const time = timed ? { timestamp: new Date(NOW - 3600000).toISOString() } : {}
  return provider === 'claude' ? { uuid: id, type: 'user', sessionId: 'native-main', message: { role: 'user', content: text }, ...time }
    : { id, parentId: parent, type: 'message', message: { role: 'user', content: [{ type: 'text', text }] }, ...time }
}
async function fixture(provider: 'claude' | 'pi', count = 1) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  const originalView = conversationView.useConversationView
  type Inspect = ReturnType<typeof originalView>['inspect']
  const inspectors = new Set<Inspect>()
  vi.spyOn(conversationView, 'useConversationView').mockImplementation((...args) => {
    const view = originalView(...args)
    if (args[1]?.agentSessionId === A && args[2] !== false) inspectors.add(view.inspect)
    return view
  })
  const directory = await mkdtemp(join(tmpdir(), 'native-refresh-'))
  const path = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  const records = Array.from({ length: count }, (_, i) => row(provider, `row-${i}`, i ? `row-${i - 1}` : null))
  await writeFile(path, jsonl([...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'native-main', cwd: directory }] : []), ...records]))
  const originalNative = await readFile(path), appendedNative: Buffer[] = []
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: A, providerId: provider, executorId: provider, hostId: 'local', workspacePath: directory,
    run: { runId: 'private-run-no-daemon' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: provider, sessionId: 'native-main', transcriptPath: path } }
  await store.compareAndSwap(null, stored)
  const durableBefore = await store.loadMetadata()
  const physical: Promise<unknown>[] = []
  const load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const reading = load(); physical.push(reading); return reading })
  const client = new AgentMuxClient({ store })
  const nativeProvider = client.providers.get(provider)
  if (!hasNativeObservation(nativeProvider)) throw new Error('The original built-in Provider must own native history observation')
  const physicalWatch = vi.spyOn(nativeProvider, 'observeSessionHistory')
  const kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('No Runtime control ' + name) }))
  cleanups.push(
    async () => { expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]) },
    async () => { expect(await store.loadMetadata()).toEqual(durableBefore) },
    async () => { expect(await readFile(path)).toEqual(Buffer.concat([originalNative, ...appendedNative])) },
    async () => { await client.dispose() },
    async () => { await Promise.allSettled(physical); await rm(directory, { recursive: true, force: true }) }
  )
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: A, run: stored.run! }
  const reads: AgentSessionHistoryPage[] = []
  const originalRead: (agentSessionId: string, options: AgentSessionHistoryPageOptions,
    source?: AgentSessionHistorySource) => Promise<AgentSessionHistoryPage> = client['readSessionHistoryPage']
  const history = vi.fn(async function (this: AgentMuxClient, ...args: Parameters<typeof originalRead>) {
    const [agentSessionId, , source] = args
    expect(this).toBe(client)
    expect(agentSessionId).toBe(A)
    if (source) expect(source).toEqual({ providerId: provider, nativeSessionId: 'native-main' })
    const page = await originalRead.apply(this, args); reads.push(page); return page
  })
  client['readSessionHistoryPage'] = history
  cleanups.unshift(async () => { client['readSessionHistoryPage'] = originalRead })
  const changes = vi.spyOn(client, 'readConversationChanges')
  const observe = vi.spyOn(client, 'observeConversation')
  const coreReads = vi.spyOn(client, 'readAgentConversation')
  const bridgeCloses: Array<() => unknown | Promise<unknown>> = []
  await desktopConversationReadBridge({ root: directory, client }, bridgeCloses)
  for (const close of bridgeCloses) cleanups.unshift(async () => { await close() })
  vi.spyOn(api.sessions, 'historySources').mockImplementation(async () => ({ sources: await client.sessionHistorySources(), warnings: [] }))
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: directory })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const config: AppConfig = { version: 9, hosts: [], executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  config.hosts = [{ id: 'local', kind: 'local', label: 'Private' }]
  config.executors = { [provider]: { providerId: provider, label: provider, command: provider, args: [], env: {}, injectAgentMuxGuide: false } }
  config.workspaces = [{ id: 'native-project', hostId: 'local', name: 'Native reading', path: directory, kind: 'folder' }]
  const sessions: SessionSnapshot[] = [A, C].map(id => ({ id, kind: 'agent', providerId: provider, executorId: provider, hostId: 'local', workspacePath: directory,
    label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { ...control, agentSessionId: id } }))
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, layouts: {}, recoveryCandidates: [], agentNames: {}, mainSurface: 'agents', activeWorkspaceId: 'native-project',
    agentFocus: { execution: { sessionId: A, history: [] }, pmo: { sessionId: null } } })
  const node = document.createElement('div'); document.body.append(node); nodes.push(node)
  const root = createRoot(node); roots.push(root)
  const render = (enabled = true, focus = false) => act(async () => root.render(<><Conversation control={control} enabled={enabled} />{focus ? <GlobalFocusSurface /> : null}</>))
  const wait = (check: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve() }); check() }, { timeout: 3000, interval: 10 })
  const waitReaders = async (ids: string[], earlier?: ReadonlyMap<Inspect, number>, expectedReaders = 3) => {
    let accepted = new Map<Inspect, number>()
    await wait(() => {
      const active = [...inspectors].map(inspect => ({ inspect, value: inspect() })).filter(({ value }) => value.watch.bound)
      expect(active).toHaveLength(expectedReaders) // Original input summary and Activity, plus Focus only when mounted.
      for (const { inspect, value } of active) {
        expect(value).toMatchObject({ loading: false, inFlight: false, dirty: false, pending: null,
          error: null, sourceError: null, observationError: null, watch: { binding: false, bound: true, closed: false } })
        expect(value.snapshot!.units.flatMap(unit => unit.records.map(record => record.original.item.id))).toEqual([...ids].reverse())
        if (earlier) {
          expect(earlier.has(inspect), 'The original mounted reader must survive its native append').toBe(true)
          expect(value.watch.invalidations).toBeGreaterThan(earlier.get(inspect)!)
        }
      }
      accepted = new Map(active.map(({ inspect, value }) => [inspect, value.watch.invalidations]))
    })
    return accepted
  }
  return { provider, path, directory, client, control, history, changes, observe, coreReads, physicalWatch, reads, node, root, render, wait, waitReaders,
    append: async (values: unknown[]) => {
      const data = jsonl(values)
      await appendFile(path, data); appendedNative.push(Buffer.from(data))
    },
    waitRows: (ids: string[]) => wait(() => { expect(current?.error).toBeNull(); expect(current?.nativeHistoryPage?.items.map(item => item.id)).toEqual(ids); expect(current?.messages.map(item => item.rawId)).toEqual(ids) }) }
}

for (const provider of ['claude', 'pi'] as const) {
  it(`${provider}: original public windows append distinct same-body IDs to Conversation and Focus while retaining unknown time`, async () => {
    const h = await fixture(provider)
    await h.render(true, true); await h.waitRows(['row-0'])
    await h.wait(() => expect([...h.node.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')]
      .map(row => row.dataset.nativeRecordId)).toEqual(['row-0']))
    expect(h.node.querySelectorAll('.activity-feed .log-turn__body')).toHaveLength(1)
    expect(h.observe).toHaveBeenCalled()
    expect(h.observe.mock.calls.every(([reference]) => reference.agentSessionId === A && reference.hostId === 'local')).toBe(true)
    const initialReaders = await h.waitReaders(['row-0'])
    const body = h.node.querySelector<HTMLElement>('.activity-feed .log-turn__body p')!
    expect(body.textContent).toBe('Identical native body.')
    const range = document.createRange(); range.selectNodeContents(body); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    await h.append([row(provider, 'same-body-new', 'row-0'), row(provider, 'untimed-new', 'same-body-new', false)])
    await h.waitRows(['row-0', 'same-body-new', 'untimed-new'])
    await h.wait(() => expect([...h.node.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')]
      .map(row => row.dataset.nativeRecordId)).toEqual(['row-0', 'same-body-new', 'untimed-new']))
    expect(current!.messages.map(message => [message.rawId, message.author.kind, message.recordedAt === undefined])).toEqual([
      ['row-0', 'unknown', false], ['same-body-new', 'unknown', false], ['untimed-new', 'unknown', true]
    ])
    expect(h.node.querySelector('.activity-feed .log-turn__body p')).toBe(body)
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(body)
    await h.wait(() => expect([...h.node.querySelectorAll<HTMLElement>('.recent-focus__message')].reduce((n, marker) => n + Number(marker.dataset.recordCount), 0)).toBe(2))
    const markers = [...h.node.querySelectorAll<HTMLElement>('.recent-focus__message')]
    expect(markers.flatMap(marker => JSON.parse(marker.dataset.messageRawIds!))).toEqual(['row-0', 'same-body-new'])
    const records = h.node.querySelector<HTMLButtonElement>('[aria-label="View conversation records"]')!
    expect(records).not.toBeNull(); await act(async () => records.click())
    await h.wait(() => expect(document.querySelectorAll('[aria-label="Available conversation records"] [data-conversation-record-id]')).toHaveLength(3))
    expect([...document.querySelectorAll<HTMLElement>('[aria-label="Available conversation records"] [data-conversation-record-id]')].map(item => item.dataset.recordRawId)).toEqual(['row-0', 'same-body-new', 'untimed-new'])
    await h.waitReaders(['row-0', 'same-body-new', 'untimed-new'], initialReaders)
    if (provider === 'claude') {
      const proof = '.bagakit/feature-tracker/conversation-input-cards-artifacts/T006'
      await mkdir(proof, { recursive: true })
      await writeFile(join(proof, 'public-reader-pages.json'), JSON.stringify({ now: NOW, control: h.control, initial: h.reads[0], appended: current!.nativeHistoryPage,
        config: useAppStore.getState().config, sessions: useAppStore.getState().sessions, historySources: await h.client.sessionHistorySources(),
        boundary: 'Actual built-in Claude reader/public Core/FileStore DTOs from isolated recorded files; no vendor CLI or physical channel qualification.' }, null, 2) + '\n')
    }
    const before = h.history.mock.calls.length, changesBefore = h.changes.mock.calls.length
    await writeFile(join(h.directory, 'unrelated-c.jsonl'), jsonl([row(provider, 'unrelated', null)]))
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === C ? { ...session, latestOutputBytes: 999 } : session) })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
    expect(h.history).toHaveBeenCalledTimes(before)
    expect(h.changes).toHaveBeenCalledTimes(changesBefore)
  })
}

it('Claude accepted queued commands flow through the public reader and exact-file observer into the common labeled cards', async () => {
  const h = await fixture('claude')
  await h.render(); await h.waitRows(['row-0'])
  await h.wait(() => expect([...h.node.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')]
    .map(row => row.dataset.nativeRecordId)).toEqual(['row-0']))
  const initialReaders = await h.waitReaders(['row-0'], undefined, 2)
  const frames = [...initialReaders.keys()].map(inspect => inspect().snapshot!)
  expect(frames[0]!.window.id).not.toBe(frames[1]!.window.id)
  expect(h.observe.mock.calls).toHaveLength(4)
  const openings = await Promise.all(h.observe.mock.results.map(result => {
    expect(result.type).toBe('return')
    if (result.type !== 'return') throw new Error('An original conversation observation did not return its handle')
    return result.value
  }))
  const currentOpenings = h.observe.mock.calls.flatMap(([reference], index) => reference.view === undefined ? [openings[index]!] : [])
  expect(currentOpenings).toHaveLength(2)
  await h.wait(() => { for (const opening of currentOpenings) expect(opening.closed.aborted).toBe(true) })
  const originalPages = await Promise.all(h.coreReads.mock.results.map(result => {
    expect(result.type).toBe('return')
    if (result.type !== 'return') throw new Error('An original SDK window read did not return its page')
    return result.value
  }))
  for (const frame of frames) {
    const pages = originalPages.filter(page => page.window.id === frame.window.id)
    expect(pages).toHaveLength(1)
    expect(pages[0]!.scope).toEqual(frame.scope)
    // Hosted transport wraps opaque cursors. Match the original SDK lease to
    // its original SDK opening without decoding either transport's token.
    const fixed = h.observe.mock.calls.flatMap(([reference], index) => reference.view === pages[0]!.window.view ? [openings[index]!] : [])
    expect(fixed).toHaveLength(1)
    expect(fixed[0]!.closed.aborted).toBe(false)
    expect(fixed[0]!.scope).toEqual(frame.scope)
    expect(frame.scope.sources.filter(source => source.kind === 'native')).toEqual([{ kind: 'native', providerId: 'claude', nativeSessionId: 'native-main' }])
  }
  for (let index = 0; index < openings.length; index++) {
    expect(h.observe.mock.calls[index]![0]).toMatchObject({ hostId: 'local', agentSessionId: A })
    expect(openings[index]!.scope).toEqual(frames[0]!.scope)
  }
  expect(h.physicalWatch).toHaveBeenCalledOnce()
  const nativeContext = h.physicalWatch.mock.calls[0]![0]
  expect(nativeContext).toMatchObject({ source: { providerId: 'claude', nativeSessionId: 'native-main' }, transcriptPath: h.path })
  const nativeResult = h.physicalWatch.mock.results[0]!
  expect(nativeResult.type).toBe('return')
  if (nativeResult.type !== 'return') throw new Error('The original native observation did not return its handle')
  const nativeHandle = await nativeResult.value
  expect(nativeHandle.source).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
  expect(nativeHandle.closed?.aborted).toBe(false); expect(nativeContext.signal.aborted).toBe(false)
  const original = h.node.querySelector<HTMLElement>('.activity-feed .log-turn__body p')!
  const range = document.createRange(); range.selectNodeContents(original)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  const queued = (id: string) => ({ type: 'attachment', uuid: id, sessionId: 'native-main', isSidechain: false,
    timestamp: new Date(NOW).toISOString(), attachment: { type: 'queued_command', commandMode: 'prompt',
      prompt: '什么情况了?', source_uuid: 'command-' + id, delivery_id: 'delivery-' + id, origin: { kind: 'human' }, humanTurn: true },
    renderedRole: 'system', rendered: [{ content: 'An original native wrapper, not the input body.' }] })
  await h.append([{ type: 'queue-operation', operation: 'enqueue', sessionId: 'native-main', content: '什么情况了?' },
    queued('mid-turn-1'), queued('mid-turn-2')])
  await h.wait(() => {
    expect(current?.messages.map(message => message.rawId)).toEqual(['row-0', 'mid-turn-1', 'mid-turn-2'])
    expect([...h.node.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')]
      .map(row => row.dataset.nativeRecordId)).toEqual(['row-0', 'mid-turn-1', 'mid-turn-2'])
    expect(h.node.querySelectorAll('.activity-feed .log-turn__sender-kind')).toHaveLength(2)
  })
  for (const id of ['mid-turn-1', 'mid-turn-2']) {
    const card = h.node.querySelector<HTMLElement>('[data-native-record-id="' + id + '"] .log-turn')!
    expect(card).not.toBeNull()
    expect(card.querySelector('.log-turn__body')?.textContent).toBe('什么情况了?')
    expect(card.querySelector('.log-turn__sender-kind')?.textContent).toBe('运行中追加')
    expect(card.getAttribute('data-speaker-role')).toBe('human') // Display convention, not recorded authorship.
  }
  expect(current!.messages.slice(1).map(message => message.author.kind)).toEqual(['unknown', 'unknown'])
  expect(current!.nativeHistoryPage!.items.find(item => item.kind === 'activity')?.contentParts[0]?.kind).toBe('text')
  expect(h.node.querySelector('.activity-feed .log-turn__body p')).toBe(original)
  expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(original)
  const completeNativeIds = current!.nativeHistoryPage!.items.map(item => item.id)
  expect(completeNativeIds).toHaveLength(4)
  await h.waitReaders(completeNativeIds, initialReaders, 2)
  expect(h.observe.mock.calls).toHaveLength(openings.length)
  expect(h.physicalWatch).toHaveBeenCalledOnce()
  expect(nativeHandle.closed?.aborted).toBe(false); expect(nativeContext.signal.aborted).toBe(false)
  const reads = h.history.mock.calls.length, changes = h.changes.mock.calls.length
  await writeFile(join(h.directory, 'unrelated-c.jsonl'), jsonl([row('claude', 'unrelated', null)]))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === C ? { ...session, latestOutputBytes: 999 } : session) })))
  await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
  expect(h.history).toHaveBeenCalledTimes(reads); expect(h.changes).toHaveBeenCalledTimes(changes)
  expect(h.observe.mock.calls).toHaveLength(openings.length); expect(h.physicalWatch).toHaveBeenCalledOnce()
  if (process.env.AGENTMUX_CLAUDE_QUEUED_PUBLIC_PAGE) {
    await writeFile(process.env.AGENTMUX_CLAUDE_QUEUED_PUBLIC_PAGE, JSON.stringify(current!.nativeHistoryPage, null, 2) + '\n')
  }
})
