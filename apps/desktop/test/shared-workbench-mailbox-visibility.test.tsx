// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryPage } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'

const A = 'private-visible-mailbox', C = 'private-unrelated-mailbox'
const baseline = useAppStore.getState(), roots: Root[] = [], nodes: HTMLElement[] = [], closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const close of closers.splice(0)) await close()
  useAppStore.setState(baseline, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
function record(id: string) { return { uuid: id, type: 'user', sessionId: 'native-private-mailbox',
  message: { role: 'user', content: 'Original native message, retained while hidden.' }, timestamp: '2026-10-05T00:00:00Z' } }
function Witness({ control }: { control: AgentSessionControl }) {
  const { messages } = useSessionUserMessages(control, { enabled: true })
  return <output data-visible-witness>{messages.map(message => message.id).join('\n')}</output>
}
async function fixture(initialVisible = true, readOnly = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const directory = await mkdtemp(join(tmpdir(), 'mailbox-binding-visibility-'))
  const transcript = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  await writeFile(transcript, jsonl([record('initial')]))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: A, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
    run: { runId: 'private-mailbox-running' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-private-mailbox', transcriptPath: transcript } }
  await store.compareAndSwap(null, stored)
  const storeBytes = await readFile(storePath), physical: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const value = load(); physical.push(value); return value })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error('No Runtime control ' + name) }))
  const releases: (() => void)[] = []
  closers.push(async () => {
    for (const release of releases) release()
    expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(await readFile(storePath)).toEqual(storeBytes)
    await client.dispose(); await Promise.allSettled(physical)
    await rm(directory, { recursive: true, force: true })
  })
  const control: AgentSessionControl = { kind: 'agent', hostId: 'local', agentSessionId: A, run: stored.run! }
  let holdNext = false, pending: { page: AgentSessionHistoryPage; release: () => void } | undefined
  const history = vi.spyOn(api.sessions, 'historyPage').mockImplementation(async (reference, options) => {
    expect(reference.agentSessionId).toBe(A)
    const page = await client.sessionHistoryPage(A, options)
    if (holdNext) { holdNext = false; await new Promise<void>(resolve => { releases.push(resolve); pending = { page, release: resolve } }) }
    return page
  })
  const observe = vi.spyOn(api.sessions, 'observeHistory').mockImplementation((reference, listener, options) => client.observeSessionHistory(reference.agentSessionId, listener, options))
  const sessions: SessionSnapshot[] = [A, C].map(id => ({ id, kind: 'agent', hostId: 'local', providerId: 'claude', executorId: 'claude', workspacePath: directory, label: id,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0, control: { ...control, agentSessionId: id },
    status: { state: 'running', source: 'run-process', observedAt: 1 }, capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' } }))
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { claude: { providerId: 'claude', label: 'Claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'private-mailbox-workspace', hostId: 'local', name: 'Private reading', path: directory, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  useAppStore.setState({ config, sessions, timelines: {}, noticeReadReceipts: {}, agentNames: {},
    agentComposerDrafts: { [A]: 'Keep this original draft' }, agentSteerQueues: {} })
  const node = document.createElement('div'); document.body.append(node); nodes.push(node)
  const root = createRoot(node); roots.push(root)
  const render = (visible: boolean, witness = false) => act(async () => root.render(<>
    <section data-mailbox-stage hidden={!visible}><AgentSessionComposer sessionId={A} visible={visible} readOnly={readOnly} /></section>
    {witness ? <Witness control={control} /> : null}
  </>))
  await render(initialVisible)
  const mailbox = node.querySelector<HTMLElement>('.composer-mailbox')!
  expect(mailbox).not.toBeNull()
  const toggle = async (open: boolean) => { const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: open ? 'open' : 'closed' }); await act(async () => mailbox.dispatchEvent(event)) }
  const wait = (check: () => void) => act(async () => vi.waitFor(check, { timeout: 3000, interval: 10 }))
  const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 150)))
  const rows = () => [...mailbox.querySelectorAll<HTMLElement>('.composer-mailbox__history [data-record-key]')]
  const detail = async () => {
    expect(rows()).toHaveLength(1)
    await act(async () => rows()[0]!.click())
    const body = mailbox.querySelector<HTMLElement>('.composer-mailbox__full-text')!
    expect(body).not.toBeNull(); expect(body.textContent).toBe(record('initial').message.content)
    const range = document.createRange(); range.selectNodeContents(body)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    const content = mailbox.querySelector<HTMLElement>('.composer-mailbox__content')!; content.scrollTop = 19
    const editor = node.querySelector<HTMLElement>('[contenteditable]')!
    expect(editor).not.toBeNull()
    return { body, range, selection, content, editor }
  }
  const retained = (original: Awaited<ReturnType<typeof detail>>) => {
    expect(mailbox.querySelector('.composer-mailbox__full-text')).toBe(original.body)
    expect(original.body.isConnected).toBe(true); expect(original.range.startContainer).toBe(original.body)
    expect(original.selection.getRangeAt(0).startContainer).toBe(original.body)
    expect(original.content.scrollTop).toBe(19)
    expect(node.querySelector('[contenteditable]')).toBe(original.editor)
    expect(useAppStore.getState().agentComposerDrafts[A]).toBe('Keep this original draft')
    expect(useAppStore.getState().sessions).toBe(sessions)
  }
  await toggle(true)
  await act(async () => mailbox.querySelector<HTMLButtonElement>('[role="tab"][id$="-outbox-tab"]')!.click())
  if (initialVisible) await wait(() => expect(rows()).toHaveLength(1))
  return { node, mailbox, root, control, history, observe, rows, render, toggle, wait, settle, detail, retained,
    append: (id: string) => appendFile(transcript, jsonl([record(id)])),
    hold: () => { holdNext = true }, pending: () => pending }
}

it('an open retained Composer Mailbox stops native observation when its Stage hides and keeps body, Range, scroll and draft through a late page and Return', async () => {
  const h = await fixture(), original = await h.detail()
  h.hold(); await h.append('pending-before-hidden')
  await h.wait(() => { expect(h.pending()?.page.items.length).toBe(2) })
  await h.render(false)
  const reads = h.history.mock.calls.length, observations = h.observe.mock.calls.length
  expect(reads).toBe(2)
  await act(async () => h.pending()!.release()); await h.settle(); h.retained(original)
  await h.append('appended-while-hidden'); await h.settle()
  expect(h.history).toHaveBeenCalledTimes(reads); expect(h.observe).toHaveBeenCalledTimes(observations)
  h.retained(original)
  h.hold(); await h.render(true)
  await h.wait(() => expect(h.pending()?.page.items.length).toBe(3))
  h.retained(original)
  await act(async () => h.pending()!.release()); await h.settle(); h.retained(original)
  expect(h.history).toHaveBeenCalledTimes(reads + 1)
  await act(async () => h.mailbox.querySelector<HTMLButtonElement>('.composer-mailbox__back button')!.click())
  expect(h.rows().map(row => row.dataset.recordKey)).toEqual([
    'native:native:claude:native-private-mailbox:initial',
    'native:native:claude:native-private-mailbox:pending-before-hidden',
    'native:native:claude:native-private-mailbox:appended-while-hidden'
  ])
})

it('a visible same-control consumer continues while the hidden Mailbox freezes its own original rendered records', async () => {
  const h = await fixture(), original = await h.detail()
  await h.render(true, true); expect(h.history).toHaveBeenCalledTimes(1)
  await h.render(false, true)
  await h.append('other-visible-consumer')
  await h.wait(() => expect(h.node.querySelector('[data-visible-witness]')!.textContent).toContain('other-visible-consumer'))
  expect(h.history).toHaveBeenCalledTimes(2); h.retained(original)
  const reads = h.history.mock.calls.length
  await h.render(false, false); await h.append('all-hidden')
  await h.settle(); expect(h.history).toHaveBeenCalledTimes(reads); h.retained(original)
})

it('opening a Mailbox on an already hidden Stage creates no demand and becoming visible reads the exact Session', async () => {
  const h = await fixture(false)
  await h.settle()
  expect(h.history).toHaveBeenCalledTimes(0); expect(h.observe).toHaveBeenCalledTimes(0)
  expect(h.rows()).toEqual([])
  await h.render(true); await h.wait(() => expect(h.rows()).toHaveLength(1))
  expect(h.history).toHaveBeenCalledTimes(1)
  expect(h.rows()[0]!.dataset.recordKey).toBe('native:native:claude:native-private-mailbox:initial')
})

it('readonly visible Mailbox still reads, closed visible Mailbox pauses, and unrelated Session updates add zero work', async () => {
  const h = await fixture(true, true)
  expect(h.history).toHaveBeenCalledTimes(1)
  const sessions = useAppStore.getState().sessions
  await act(async () => useAppStore.setState({ sessions: sessions.map(session => session.id === C ? { ...session, latestOutputBytes: 88 } : session) }))
  await h.settle(); expect(h.history).toHaveBeenCalledTimes(1)
  await h.toggle(false); await h.append('closed-visible'); await h.settle()
  expect(h.history).toHaveBeenCalledTimes(1)
  await h.toggle(true)
  await act(async () => h.mailbox.querySelector<HTMLButtonElement>('[role="tab"][id$="-outbox-tab"]')!.click())
  await h.wait(() => expect(h.rows()).toHaveLength(2))
  expect(h.history).toHaveBeenCalledTimes(2)
})
