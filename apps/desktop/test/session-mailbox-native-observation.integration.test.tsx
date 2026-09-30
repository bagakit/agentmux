// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'

const NOW = Date.parse('2026-10-04T10:00:00Z'), A = 'mailbox-native-a', C = 'mailbox-unrelated-c'
const baseline = useAppStore.getState(), roots: Root[] = [], nodes: HTMLElement[] = [], closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const close of closers.splice(0)) await close()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
function record(id: string, timed = true) { return { uuid: id, type: 'user', sessionId: 'native-mailbox', message: { role: 'user', content: 'Same native body.' }, ...(timed ? { timestamp: new Date(NOW - 3600000).toISOString() } : {}) } }
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
async function fixture(count = 1) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = await mkdtemp(join(tmpdir(), 'mailbox-native-source-'))
  const transcript = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  await writeFile(transcript, jsonl(Array.from({ length: count }, (_, i) => record(`row-${i}`))))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: A, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
    run: { runId: 'private-mailbox-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-mailbox', transcriptPath: transcript } }
  await store.compareAndSwap(null, stored)
  const bytes = await readFile(storePath), physical: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const value = load(); physical.push(value); return value })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('No user Runtime control ' + name) }))
  closers.push(async () => { expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]); expect(await readFile(storePath)).toEqual(bytes); await client.dispose(); await Promise.allSettled(physical); await rm(directory, { recursive: true, force: true }) })
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: A, run: stored.run! }
  const pages: AgentSessionHistoryPage[] = []
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (reference, options) => { expect(reference.agentSessionId).toBe(A); const page = await client.sessionHistoryPage(A, options); pages.push(page); return page })
  const observe = vi.spyOn(api.sessions, 'observeHistory').mockImplementation((reference, listener, options) => client.observeSessionHistory(reference.agentSessionId, listener, options))
  const sessions: SessionSnapshot[] = [A, C].map(id => ({ id, kind: 'agent', hostId: 'local', providerId: 'claude', executorId: 'claude', workspacePath: directory, label: id,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0, control: { ...control, agentSessionId: id },
    status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' } }))
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { claude: { providerId: 'claude', label: 'Claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'private-mailbox', hostId: 'local', name: 'Private reading', path: directory, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  useAppStore.setState({ config, sessions, timelines: {}, noticeReadReceipts: {} })
  const node = document.createElement('div'); document.body.append(node); nodes.push(node); const root = createRoot(node); roots.push(root)
  const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
  await act(async () => root.render(<SessionMailbox system={system} queued={[]} control={control} />))
  const mailbox = node.querySelector<HTMLElement>('.composer-mailbox')!
  expect(mailbox).not.toBeNull()
  const toggle = async (open: boolean) => { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: open ? 'open' : 'closed' }); await act(async () => mailbox.dispatchEvent(event)) }
  const wait = (check: () => void) => act(async () => vi.waitFor(check, { timeout: 3000, interval: 10 }))
  const rows = () => [...mailbox.querySelectorAll<HTMLElement>('.composer-mailbox__history [data-record-key]')]
  const click = async (text: string) => { const button = [...mailbox.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text); expect(button).toBeDefined(); await act(async () => button!.click()) }
  await toggle(true)
  await act(async () => mailbox.querySelector<HTMLButtonElement>('[role="tab"][id$="-outbox-tab"]')!.click())
  await wait(() => expect(rows()).toHaveLength(Math.min(30, count)))
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 100)))
  return { directory, transcript, client, control, sessions, config, node, mailbox, history, observe, pages, rows, click, toggle, wait, settle,
    append: (rows: unknown[]) => appendFile(transcript, jsonl(rows)) }
}

it('an open actual Mailbox keeps the ninety-record window and original Range when Session status/output/timestamps change without a native source fact', async () => {
  const h = await fixture(90)
  await h.click('Load earlier messages'); await h.wait(() => expect(h.rows()).toHaveLength(60))
  await h.click('Load earlier messages'); await h.wait(() => expect(h.rows()).toHaveLength(90))
  expect(h.history).toHaveBeenCalledTimes(3)
  const body = h.rows()[0]!.querySelector('.composer-mailbox__preview')!
  const range = document.createRange(); range.selectNodeContents(body)
  h.mailbox.querySelector('.composer-mailbox__content')!.scrollTop = 15
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => ({ ...session, updatedAt: 2, agentSessionUpdatedAt: 2, latestOutputBytes: 99 })) })))
  await h.settle()
  expect(h.history).toHaveBeenCalledTimes(3)
  expect(h.rows()).toHaveLength(90); expect(h.rows()[0]!.querySelector('.composer-mailbox__preview')).toBe(body)
  expect(range.startContainer).toBe(body); expect(body.isConnected).toBe(true)
  expect(h.mailbox.querySelector('.composer-mailbox__content')!.scrollTop).toBe(15)
})

it('only exact native source append updates the actual Mailbox, retaining equal bodies and missing time while hidden reading costs zero', async () => {
  const h = await fixture()
  const body = h.rows()[0]!.querySelector('.composer-mailbox__preview')!
  expect(h.rows()[0]!.dataset.recordKey).toBe('native:native:claude:native-mailbox:row-0')
  await h.append([record('same-body-new'), record('untimed-new', false)])
  await h.wait(() => expect(h.rows()).toHaveLength(3))
  expect(h.rows().map(row => row.dataset.recordKey)).toEqual(['native:native:claude:native-mailbox:row-0', 'native:native:claude:native-mailbox:same-body-new', 'native:native:claude:native-mailbox:untimed-new'])
  expect(h.rows()[0]!.querySelector('.composer-mailbox__preview')).toBe(body)
  expect(h.rows()[2]!.textContent).toContain('Time not recorded')
  const before = h.history.mock.calls.length
  await writeFile(join(h.directory, 'unrelated-c.jsonl'), jsonl([record('unrelated')]))
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === C ? { ...session, updatedAt: 8, latestOutputBytes: 888 } : session) })))
  await h.settle(); expect(h.history).toHaveBeenCalledTimes(before)
  await h.toggle(false); await h.append([record('hidden')]); await h.settle()
  expect(h.history).toHaveBeenCalledTimes(before)
  await h.toggle(true); await h.wait(() => expect(h.rows()).toHaveLength(4))
  expect(h.history).toHaveBeenCalledTimes(before + 1)
})

it('automatic observation unsupported is a visible Mailbox service notice and explicit Refresh preserves readable native records', async () => {
  const h = await fixture()
  h.observe.mockRejectedValueOnce(Object.assign(new Error('The private source cannot be automatically observed.'), { code: 'AGENT_SESSION_HISTORY_OBSERVATION_UNSUPPORTED' }))
  // Reopen asks the original observer owner again; neither state nor output triggers this.
  await h.toggle(false); await h.toggle(true)
  await h.wait(() => expect(h.mailbox.textContent).toContain('Automatic native updates are unavailable'))
  expect(h.rows()).toHaveLength(1); expect(h.mailbox.textContent).toContain('Existing messages are kept')
  const before = h.history.mock.calls.length
  await h.click('Refresh source'); await h.wait(() => expect(h.history).toHaveBeenCalledTimes(before + 1))
  expect(h.rows()).toHaveLength(1)
})

it('actual Mailbox freezes its original bounded window on source append and only Read latest records opens a new window', async () => {
  const h = await fixture(90)
  await h.click('Load earlier messages'); await h.wait(() => expect(h.rows()).toHaveLength(60))
  await h.click('Load earlier messages'); await h.wait(() => expect(h.rows()).toHaveLength(90))
  const body = h.rows()[0]!.querySelector('.composer-mailbox__preview')!, range = document.createRange(); range.selectNodeContents(body)
  await h.append([record('outside-window')])
  await h.wait(() => expect(h.mailbox.textContent).toContain('This bounded reading window is kept'))
  expect(h.rows()).toHaveLength(90); expect(h.rows()[0]!.querySelector('.composer-mailbox__preview')).toBe(body); expect(range.startContainer).toBe(body)
  const before = h.history.mock.calls.length
  await h.append([record('also-outside', false)]); await h.settle(); expect(h.history).toHaveBeenCalledTimes(before)
  await h.click('Read latest records'); await h.wait(() => expect(h.rows()).toHaveLength(30))
  expect(h.rows().map(row => row.dataset.recordKey)).toContain('native:native:claude:native-mailbox:also-outside')
  const proof = '.bagakit/feature-tracker/conversation-input-cards-artifacts/T012'
  await mkdir(proof, { recursive: true })
  await writeFile(join(proof, 'public-reader-pages.json'), JSON.stringify({ control: h.control, sessions: h.sessions, config: h.config, earlierPages: h.pages.slice(0, 3), latest: h.pages.at(-1),
    boundary: 'Actual Claude public reader/private FileStore; browser preview invalidations explicitly adapted; no user App/Run/Runtime or physical Writer.' }, null, 2) + '\n')
})

it('a failed Mailbox reread keeps its original body and source recovery only comes from relevant native invalidation', async () => {
  const h = await fixture(), body = h.rows()[0]!.querySelector('.composer-mailbox__preview')!
  h.history.mockRejectedValueOnce(new Error('Private native reader could not read its source.'))
  await h.append([record('after-error')])
  await h.wait(() => expect(h.mailbox.textContent).toContain('Failed to read native conversation history'))
  expect(h.rows()).toHaveLength(1); expect(h.rows()[0]!.querySelector('.composer-mailbox__preview')).toBe(body)
  await h.append([record('after-recovery')]); await h.wait(() => expect(h.rows()).toHaveLength(3))
  expect(h.rows()[0]!.querySelector('.composer-mailbox__preview')).toBe(body)
})
