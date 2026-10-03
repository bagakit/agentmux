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
import type { AgentSessionHistoryObservationHandle, AgentSessionHistoryPage, AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => createElement('output', { 'data-terminal-leaf': 'isolated' }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const NOW = Date.parse(_hygiene_fixtureIso(23882400000, "second"))
const A = 'native-refresh-a', C = 'native-refresh-unrelated-c'
const baseline = useAppStore.getState()
const roots: Root[] = [], nodes: HTMLElement[] = [], cleanups: (() => Promise<void>)[] = []
type Read = ReturnType<typeof useSessionUserMessages>
let current: Read | undefined
function Conversation({ control, enabled = true }: { control: AgentSessionControl; enabled?: boolean }) {
  const read = useSessionUserMessages(control, { enabled })
  useEffect(() => { current = read }, [read])
  return <ActivityView sessionId={control.agentSessionId} items={[]} userMessages={read.messages} nativeHistoryPage={read.nativeHistoryPage}
    userMessageRead={{ loading: read.loading, error: read.error, observationError: read.observationError, windowFrozen: read.windowFrozen,
      hasMore: read.hasMore, onRetry: () => void read.refresh(), onReadEarlier: () => {} }} capability="complete-events" displayState="done" />
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const close of cleanups.splice(0)) await close()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  current = undefined
  document.getElementById('agentmux-window-overlay-host')?.remove()
})
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
  const directory = await mkdtemp(join(tmpdir(), 'native-refresh-'))
  const path = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  const records = Array.from({ length: count }, (_, i) => row(provider, `row-${i}`, i ? `row-${i - 1}` : null))
  await writeFile(path, jsonl([...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'native-main', cwd: directory }] : []), ...records]))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: A, providerId: provider, executorId: provider, hostId: 'local', workspacePath: directory,
    run: { runId: 'private-run-no-daemon' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: provider, sessionId: 'native-main', transcriptPath: path } }
  await store.compareAndSwap(null, stored)
  const durableBefore = await readFile(storePath)
  const physical: Promise<unknown>[] = []
  const load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const reading = load(); physical.push(reading); return reading })
  const client = new AgentMuxClient({ store })
  const kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('No Runtime control ' + name) }))
  cleanups.push(async () => {
    expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(storePath)).toEqual(durableBefore)
    await client.dispose(); await Promise.allSettled(physical); await rm(directory, { recursive: true, force: true })
  })
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: A, run: stored.run! }
  const reads: AgentSessionHistoryPage[] = []
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (reference, options) => {
    expect(reference.agentSessionId).toBe(A)
    const page = await client.sessionHistoryPage(reference.agentSessionId, options); reads.push(page); return page
  })
  const observe = vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (reference, listener, options) => {
    expect(reference.agentSessionId).toBe(A)
    return await client.observeSessionHistory(reference.agentSessionId, listener, options)
  })
  vi.spyOn(api.sessions, 'historySources').mockImplementation(() => client.sessionHistorySources())
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
  const wait = (check: () => void) => act(async () => vi.waitFor(check, { timeout: 3000, interval: 10 }))
  return { provider, path, directory, client, control, history, observe, reads, node, root, render, wait,
    append: (values: unknown[]) => appendFile(path, jsonl(values)),
    waitRows: (ids: string[]) => wait(() => { expect(current?.error).toBeNull(); expect(current?.nativeHistoryPage?.items.map(item => item.id)).toEqual(ids); expect(current?.messages.map(item => item.rawId)).toEqual(ids) }) }
}

for (const provider of ['claude', 'pi'] as const) {
  it(`${provider}: real public reader/FileStore → unique hook → mounted Conversation and Focus append distinct same-body IDs and retain unknown time`, async () => {
    const h = await fixture(provider)
    await h.render(true, true); await h.waitRows(['row-0'])
    expect(h.observe).toHaveBeenCalledTimes(1); expect(h.history).toHaveBeenCalledTimes(1)
    expect(h.observe.mock.invocationCallOrder[0]).toBeLessThan(h.history.mock.invocationCallOrder[0]!)
    const body = h.node.querySelector<HTMLElement>('.activity-feed .log-turn__body p')!
    expect(body.textContent).toBe('Identical native body.')
    const range = document.createRange(); range.selectNodeContents(body); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
    await h.append([row(provider, 'same-body-new', 'row-0'), row(provider, 'untimed-new', 'same-body-new', false)])
    await h.waitRows(['row-0', 'same-body-new', 'untimed-new'])
    expect(current!.messages.map(message => [message.rawId, message.author.kind, message.recordedAt === undefined])).toEqual([
      ['row-0', 'unknown', false], ['same-body-new', 'unknown', false], ['untimed-new', 'unknown', true]
    ])
    expect(h.node.querySelector('.activity-feed .log-turn__body p')).toBe(body)
    expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(body)
    await h.wait(() => expect(h.node.querySelectorAll('.recent-focus__message')).toHaveLength(2))
    const markers = [...h.node.querySelectorAll<HTMLElement>('.recent-focus__message')]
    expect(markers.map(marker => marker.dataset.messageId)).toEqual([`native:${provider}:native-main:row-0`, `native:${provider}:native-main:same-body-new`])
    const records = h.node.querySelector<HTMLButtonElement>('[aria-label="View input records"]')!
    expect(records).not.toBeNull(); await act(async () => records.click())
    await h.wait(() => expect(document.querySelectorAll('[data-input-source="native"][data-input-message-id]')).toHaveLength(3))
    expect([...document.querySelectorAll<HTMLElement>('[data-input-source="native"][data-input-message-id]')].map(item => item.dataset.inputMessageId)).toContain(`native:${provider}:native-main:untimed-new`)
    if (provider === 'claude') {
      const proof = '.bagakit/feature-tracker/conversation-input-cards-artifacts/T006'
      await mkdir(proof, { recursive: true })
      await writeFile(join(proof, 'public-reader-pages.json'), JSON.stringify({ now: NOW, control: h.control, initial: h.reads[0], appended: current!.nativeHistoryPage,
        config: useAppStore.getState().config, sessions: useAppStore.getState().sessions, historySources: await h.client.sessionHistorySources(),
        boundary: 'Actual built-in Claude reader/public Core/FileStore DTOs from isolated recorded files; no vendor CLI or physical channel qualification.' }, null, 2) + '\n')
    }
    const before = h.history.mock.calls.length
    await writeFile(join(h.directory, 'unrelated-c.jsonl'), jsonl([row(provider, 'unrelated', null)]))
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === C ? { ...session, latestOutputBytes: 999 } : session) })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
    expect(h.history).toHaveBeenCalledTimes(before)
  })
}

it('pending observation precedes first read; explicit unsupported still reads and reports the actual degradation', async () => {
  const h = await fixture('claude')
  let ready!: (handle: AgentSessionHistoryObservationHandle) => void
  h.observe.mockImplementationOnce(async () => await new Promise(resolve => { ready = resolve }))
  await h.render(); expect(h.history).toHaveBeenCalledTimes(0)
  await act(async () => ready({ source: { providerId: 'claude', nativeSessionId: 'native-main' }, dispose: vi.fn() }))
  await h.waitRows(['row-0']); expect(h.history).toHaveBeenCalledTimes(1)
  h.observe.mockRejectedValueOnce(Object.assign(new Error('This Provider does not support automatic observation. Refresh remains available.'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' }))
  await act(async () => current!.refresh())
  await h.wait(() => expect(current?.observationError?.message).toContain('does not support'))
  expect(current!.nativeHistoryPage!.items.map(item => item.id)).toEqual(['row-0'])
  expect(h.history).toHaveBeenCalledTimes(2)
  expect(h.node.textContent).toContain('Refresh')
  expect(h.node.textContent).toContain('Automatic')
})

it('last hidden consumer releases watch and rejects a physically completed late page while preserving body/Range and revalidating on Return', async () => {
  const h = await fixture('claude')
  await h.render(); await h.waitRows(['row-0'])
  const body = h.node.querySelector<HTMLElement>('.log-turn__body p')!
  const range = document.createRange(); range.selectNodeContents(body); document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  let late!: (page: AgentSessionHistoryPage) => void
  h.history.mockImplementationOnce(async () => await new Promise(resolve => { late = resolve }))
  await h.append([row('claude', 'late', 'row-0')])
  await h.wait(() => expect(h.history).toHaveBeenCalledTimes(2))
  await h.render(false)
  const latest = await h.client.sessionHistoryPage(A)
  await act(async () => late(latest))
  await h.append([row('claude', 'hidden', 'late')])
  await act(async () => new Promise(resolve => setTimeout(resolve, 100)))
  expect(h.history).toHaveBeenCalledTimes(2)
  expect(h.node.querySelector('.log-turn__body p')).toBe(body)
  expect(current!.nativeHistoryPage!.items.map(item => item.id)).toEqual(['row-0'])
  expect(document.getSelection()!.getRangeAt(0).startContainer).toBe(body)
  await h.render(); await h.waitRows(['row-0', 'late', 'hidden'])
  expect(h.observe).toHaveBeenCalledTimes(2)
  expect(h.node.querySelector('.log-turn__body p')).toBe(body)
})

it('three native pages retain speech and continue accepting new input without freezing', async () => {
  const h = await fixture('claude', 90)
  await h.render(); await h.waitRows(Array.from({ length: 30 }, (_, i) => `row-${60 + i}`))
  await act(async () => current!.loadEarlier()); await h.waitRows(Array.from({ length: 60 }, (_, i) => `row-${30 + i}`))
  await act(async () => current!.loadEarlier()); await h.waitRows(Array.from({ length: 90 }, (_, i) => `row-${i}`))
  expect(h.history).toHaveBeenCalledTimes(3)
  await act(async () => current!.loadEarlier()); expect(h.history).toHaveBeenCalledTimes(3)
  const first = h.node.querySelector<HTMLElement>('.log-turn__body p')!
  await h.append([row('claude', 'outside-window', 'row-89')])
  await h.waitRows([...Array.from({ length: 90 }, (_, i) => `row-${i}`), 'outside-window'])
  expect(current!.windowFrozen).toBe(false)
  expect(h.node.querySelector('.log-turn__body p')).toBe(first)
  expect(h.node.querySelectorAll('[data-native-record-id="outside-window"]')).toHaveLength(1)
  const before = h.history.mock.calls.length
  await h.append([row('claude', 'also-outside', 'outside-window')])
  await h.waitRows([...Array.from({ length: 90 }, (_, i) => `row-${i}`), 'outside-window', 'also-outside'])
  expect(h.history).toHaveBeenCalledTimes(before + 1)
  await act(async () => current!.refresh())
  await h.wait(() => expect(current!.windowFrozen).toBe(false))
  expect(current!.nativeHistoryPage!.items).toHaveLength(30)
  expect(current!.nativeHistoryPage!.items.slice(-2).map(item => item.id)).toEqual(['outside-window', 'also-outside'])
})

it('a source burst too large to bridge in three pages is retained honestly without silently skipping native records', async () => {
  const h = await fixture('pi')
  await h.render(); await h.waitRows(['row-0'])
  await h.append(Array.from({ length: 91 }, (_, i) => row('pi', `burst-${i}`, i ? `burst-${i - 1}` : 'row-0')))
  await h.waitRows(['row-0', ...Array.from({ length: 90 }, (_, i) => `burst-${i + 1}`)])
  expect(h.history).toHaveBeenCalledTimes(4)
  expect(current!.windowFrozen).toBe(false)
  expect(current!.windowIncomplete).toBe(true)
  expect(current!.nextCursor).toBeNull()
})

it('failed automatic reread keeps the original DOM; later relevant append revalidates without polling or duplicating equal bodies', async () => {
  const h = await fixture('claude')
  await h.render(); await h.waitRows(['row-0'])
  const body = h.node.querySelector('.log-turn__body p')
  h.history.mockRejectedValueOnce(new Error('Private reader unavailable'))
  await h.append([row('claude', 'after-error', 'row-0')])
  await h.wait(() => expect(current!.error?.message).toBe('Private reader unavailable'))
  expect(current!.nativeHistoryPage!.items.map(item => item.id)).toEqual(['row-0'])
  expect(h.node.querySelector('.log-turn__body p')).toBe(body)
  await h.append([row('claude', 'after-recovery', 'after-error', false)])
  await h.waitRows(['row-0', 'after-error', 'after-recovery'])
  expect(current!.messages.map(item => item.rawId)).toEqual(['row-0', 'after-error', 'after-recovery'])
  expect(h.node.querySelector('.log-turn__body p')).toBe(body)
})


it('Claude accepted queued commands flow through the public reader and exact-file observer into the common labeled cards', async () => {
  const h = await fixture('claude')
  await h.render(); await h.waitRows(['row-0'])
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
  expect(h.observe).toHaveBeenCalledTimes(1)
  if (process.env.AGENTMUX_CLAUDE_QUEUED_PUBLIC_PAGE) {
    await writeFile(process.env.AGENTMUX_CLAUDE_QUEUED_PUBLIC_PAGE, JSON.stringify(current!.nativeHistoryPage, null, 2) + '\n')
  }
})
