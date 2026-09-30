// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry } from '@agentmux/core'
import type { AgentSessionHistoryObservationHandle, AgentSessionHistoryPage, AgentMuxStoredAgentSession } from '@agentmux/core'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useSessionUserMessages } from '../src/renderer/src/lib/session-user-messages'
import { useAppStore } from '../src/renderer/src/store'
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({ SessionObservationRegions: () => createElement('output', { 'data-terminal-leaf': 'isolated' }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const NOW = Date.parse('2026-10-04T10:00:00Z')
const A = 'native-refresh-a', C = 'native-refresh-unrelated-c'
const baseline = useAppStore.getState()
const roots: Root[] = [], nodes: HTMLElement[] = [], cleanups: (() => Promise<void>)[] = []
type Read = ReturnType<typeof useSessionUserMessages>
let current: Read | undefined
function Conversation({ control, enabled = true }: { control: AgentSessionControl; enabled?: boolean }) {
  const read = useSessionUserMessages(control, { enabled })
  useEffect(() => { current = read }, [read])
  return null
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const close of cleanups.splice(0).reverse()) await close()
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
async function fixture(provider: 'claude' | 'pi', count = 1, unsupported = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)
  const directory = await mkdtemp(join(tmpdir(), 'native-refresh-'))
  cleanups.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const path = join(directory, 'native.jsonl'), storePath = join(directory, 'sessions.json')
  const records = Array.from({ length: count }, (_, i) => row(provider, `row-${i}`, i ? `row-${i - 1}` : null))
  await writeFile(path, jsonl([...(provider === 'pi' ? [{ type: 'session', version: 3, id: 'native-main', cwd: directory }] : []), ...records]))
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: A, providerId: provider, executorId: provider, hostId: 'local', workspacePath: directory,
    run: { runId: 'private-run-no-daemon' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: provider, sessionId: 'native-main', transcriptPath: path } }
  await store.compareAndSwap(null, stored)
  let durableBefore = await readFile(storePath)
  const physical: Promise<unknown>[] = []
  const load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const reading = load(); physical.push(reading); return reading })
  const providers = new AgentProviderRegistry()
  if (unsupported) { const { observeSessionHistory: ignored, ...readOnly } = providers.get(provider); providers.replace(readOnly) }
  const client = new AgentMuxClient({ store, providers: [providers.get(provider)] })
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
    expect([A, 'native-refresh-b']).toContain(reference.agentSessionId)
    const page = await client.sessionHistoryPage(reference.agentSessionId, options); reads.push(page); return page
  })
  const handles: { handle: AgentSessionHistoryObservationHandle; disposed: ReturnType<typeof vi.spyOn> }[] = []
  const observe = vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async (reference, listener, options) => {
    expect([A, 'native-refresh-b']).toContain(reference.agentSessionId)
    const handle = await client.observeSessionHistory(reference.agentSessionId, listener, options)
    handles.push({handle,disposed:vi.spyOn(handle, 'dispose')}); return handle
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
  return { provider, path, directory, client, control, history, observe, reads, node, root, render, wait, handles, store, stored, sessions,
    acceptDurable: async () => { durableBefore = await readFile(storePath) },
    append: (values: unknown[]) => appendFile(path, jsonl(values)),
    waitRows: (ids: string[]) => wait(() => { expect(current?.error).toBeNull(); expect(current?.nativeHistoryPage?.items.map(item => item.id)).toEqual(ids); expect(current?.messages.map(item => item.rawId)).toEqual(ids) }) }
}


const observationLog = process.env.AGENTMUX_FOCUS_OBSERVATION_FACTS
async function recordCounter(label: string, h: Awaited<ReturnType<typeof fixture>>) {
  const markers = Array.from(h.node.querySelectorAll<HTMLElement>('[data-message-id]')).map(item => item.dataset.messageId)
  const inputRows = Array.from(document.querySelectorAll<HTMLElement>('[data-input-message-id]')).map(item => item.dataset.inputMessageId)
  const statuses = Array.from(document.querySelectorAll<HTMLElement>('.recent-focus__input-reader [role="status"]')).map(item => item.textContent)
  const facts = { label, observationError: current?.observationError?.message, observationCode: Reflect.get(current?.observationError ?? {}, 'code'), frozen: current?.windowFrozen, rawIds: current?.nativeHistoryPage?.items.map(item=>item.id), messageIds: current?.messages.map(item=>item.id), markers, inputRows, statuses, reads: h.history.mock.calls.length, observes: h.observe.mock.calls.length }
  if (observationLog) await appendFile(observationLog, JSON.stringify(facts)+'\n'); return facts
}
async function openFocusReader(h: Awaited<ReturnType<typeof fixture>>) {
  await act(async()=>{const button=h.node.querySelector<HTMLButtonElement>('[aria-label="View input records"]');expect(button).not.toBeNull();button!.click()})
  await h.wait(()=>expect(document.querySelector('[data-input-message-id]')).not.toBeNull())
}
it('actual FileStore/public reader and unsupported observer → unique Hook → Global Focus must report preserved degraded reading', async () => {
  const h = await fixture('claude',1,true)
  await h.render(true,true);await h.waitRows(['row-0'])
  expect(current?.observationError?.message).toContain('does not support automatic native history observation')
  expect(current?.error).toBeNull();await h.wait(()=>expect(h.node.querySelector('[data-message-id]')).not.toBeNull())
  expect(h.node.querySelector('[aria-label="Timeline meaning and coverage"]')?.textContent).toContain('Updates paused')
  expect(h.node.querySelector('[aria-label="View input records"]')?.getAttribute('title')).toContain(current!.observationError!.message)
  await openFocusReader(h)
  const facts = await recordCounter('unsupported-observation',h)
  expect(facts.rawIds).toEqual(['row-0']);expect(facts.markers).toHaveLength(1);expect(facts.inputRows).toHaveLength(1);expect(facts.statuses.length).toBeGreaterThan(0)
  expect(facts.statuses.join(' '),'Focus must disclose public observationError while original input stays readable').toContain(current!.observationError!.message)
})
it('actual source burst beyond three pages → Hook frozen window → Global Focus must disclose kept records and explicit latest refill', async () => {
  const h = await fixture('claude')
  await h.render(true,true);await h.waitRows(['row-0']);await h.wait(()=>expect(h.node.querySelector('[data-message-id]')).not.toBeNull())
  await h.append(Array.from({length:91},(_,i)=>row('claude',`burst-${i}`,i?`burst-${i-1}`:'row-0')))
  await h.wait(()=>expect(current!.windowFrozen).toBe(true))
  await openFocusReader(h)
  const facts=await recordCounter('frozen-window',h)
  expect(facts.rawIds).toEqual(['row-0']);expect(facts.markers).toHaveLength(1);expect(facts.inputRows).toHaveLength(1);expect(facts.statuses.length).toBeGreaterThan(0)
  expect(facts.statuses.join(' '),'Focus must disclose windowFrozen without turning it into a new message').toContain('current reading window is kept')
})

function pinnedReading() {
  const body = document.querySelector<HTMLElement>('[data-input-preview-id]')
  expect(body).not.toBeNull()
  const walker = document.createTreeWalker(body!, NodeFilter.SHOW_TEXT)
  let text: Node | null
  while ((text = walker.nextNode())) if (text.textContent?.includes('Identical native body.')) {
    const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 8)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    return { body: body!, text, range, selection }
  }
  throw new Error('Actual native body must be nonempty before Range capture')
}
async function pin(h: Awaited<ReturnType<typeof fixture>>) {
  await openFocusReader(h)
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-input-message-id]')!.click())
  return pinnedReading()
}
it('keeps actual pinned body, DOM and Range throughout same-source Refresh pending',async()=>{
  const h=await fixture('claude');await h.render(true,true);await h.waitRows(['row-0'])
  const reading=await pin(h)
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve})
  let reached=false
  h.history.mockImplementationOnce(async(reference,options)=>{
    const page=await h.client.sessionHistoryPage(reference.agentSessionId,options);reached=true;await gate;return page
  })
  try {
    await act(async()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.recent-focus__input-actions button')).find(item=>item.textContent==='Refresh source')!.click())
    await h.wait(()=>expect(reached).toBe(true))
    expect(document.querySelector('[data-input-preview-id]'),'Refresh pending must keep pinned actual body').toBe(reading.body)
    expect(reading.body.isConnected).toBe(true);expect(reading.selection.getRangeAt(0)).toBe(reading.range)
    expect(reading.range.startContainer).toBe(reading.text);expect(reading.range.toString()).toBe('dentica')
  } finally { release();await h.wait(()=>expect(current?.loading).toBe(false)) }
})

it('real frozen window refills only by explicit original same-source action and keeps pinned reading',async()=>{
  const h=await fixture('claude');await h.render(true,true);await h.waitRows(['row-0'])
  const reading=await pin(h)
  await h.append(Array.from({length:91},(_,i)=>row('claude',`burst-${i}`,i?`burst-${i-1}`:'row-0')))
  await h.wait(()=>expect(current?.windowFrozen).toBe(true))
  expect(document.querySelector('[data-input-preview-id]')).toBe(reading.body)
  const trigger=Array.from(document.querySelectorAll<HTMLButtonElement>('.recent-focus__input-actions button')).find(item=>item.textContent==='Read latest records')
  expect(trigger).not.toBeUndefined();const reads=h.history.mock.calls.length
  await act(async()=>trigger!.click())
  await h.wait(()=>expect(current?.windowFrozen).toBe(false))
  expect(h.history.mock.calls.length).toBeGreaterThan(reads)
  await h.waitRows(Array.from({length:30},(_,i)=>`burst-${i+61}`))
  expect(document.querySelector('[data-input-preview-id]')).toBe(reading.body)
  expect(reading.selection.getRangeAt(0)).toBe(reading.range);expect(reading.range.toString()).toBe('dentica')
})
it('collapsed Focus disposes the actual observation and creates no hidden or unrelated page reads',async()=>{
  const h=await fixture('claude');await h.render(false,true)
  await h.wait(()=>expect(h.handles.length).toBe(1));await h.wait(()=>expect(h.node.querySelector('[data-message-id]')).not.toBeNull())
  expect(h.handles[0]!.disposed.mock.calls).toHaveLength(0)
  const reads=h.history.mock.calls.length,observes=h.observe.mock.calls.length
  await act(async()=>h.node.querySelector<HTMLButtonElement>('[aria-label="Collapse focus history"]')!.click())
  expect(h.handles[0]!.disposed.mock.calls,'collapsed Focus must release its public observer').toHaveLength(1)
  await h.append([row('claude','hidden-row','row-0')])
  for(let i=0;i<200;i++) await act(async()=>useAppStore.setState({sessions:h.sessions.map(item=>item.id===C?{...item,latestOutputBytes:i+1}:item)}))
  expect(h.history.mock.calls.length).toBe(reads);expect(h.observe.mock.calls.length).toBe(observes)
})
it('latest service flags and old records do not cross a real private Session source key',async()=>{
  const h=await fixture('claude',1,true);await h.render(false,true)
  await h.wait(()=>expect(h.node.querySelector('[data-message-id]')).not.toBeNull());await openFocusReader(h)
  expect(document.querySelector('[data-input-observation-notice]')?.textContent).toContain('Automatic updates unavailable')
  const path=join(h.directory,'native-b.jsonl')
  await writeFile(path,jsonl([{...row('claude','other-session-row',null,true,'Other Session native body.'),sessionId:'native-other'}]))
  const other:AgentMuxStoredAgentSession={...h.stored,agentSessionId:'native-refresh-b',run:{runId:'private-other-run-no-daemon'},nativeHandle:{kind:'provider',providerId:'claude',sessionId:'native-other',transcriptPath:path}}
  await h.store.compareAndSwap(null,other);await h.acceptDurable()
  const original=h.sessions[0]!
  expect(original.kind).toBe('agent');if(original.kind!=='agent') throw new Error('Actual seeded Agent required')
  const replacement:SessionSnapshot={...original,id:'native-refresh-b',label:'Other source',control:{kind:'agent',hostId:'local',agentSessionId:'native-refresh-b',run:other.run!}}
  await act(async()=>useAppStore.setState({sessions:[...h.sessions,replacement],agentFocus:{execution:{sessionId:replacement.id,history:[]},pmo:{sessionId:null}}}))
  await h.wait(()=>expect(Array.from(h.node.querySelectorAll<HTMLElement>('[data-message-id]')).map(item=>item.dataset.messageId)).toEqual(['native:claude:native-other:other-session-row']))
  await openFocusReader(h)
  expect(Array.from(document.querySelectorAll<HTMLElement>('[data-input-message-id]')).map(item=>item.dataset.inputMessageId)).toEqual(['native:claude:native-other:other-session-row'])
  expect(document.querySelector('.recent-focus__input-list')!.textContent).toContain('Other Session native body.')
  expect(document.querySelector('.recent-focus__input-list')!.textContent).not.toContain('Identical native body.')
  expect(h.history.mock.calls.map(call=>call[0].agentSessionId)).toEqual([A,'native-refresh-b'])
})
it('normal visible Timeline navigation and unrelated output do not increase the public read workload',async()=>{
  const h=await fixture('claude',1,true);await h.render(false,true)
  await h.wait(()=>expect(h.node.querySelector('[data-message-id]')).not.toBeNull())
  const reads=h.history.mock.calls.length,observes=h.observe.mock.calls.length
  for(let i=0;i<200;i++) await act(async()=>useAppStore.setState({sessions:h.sessions.map(item=>item.id===C?{...item,latestOutputBytes:i+1}:item)}))
  const wider=h.node.querySelector<HTMLButtonElement>('[aria-label="Zoom out Focus timeline"]')!
  const narrower=h.node.querySelector<HTMLButtonElement>('[aria-label="Zoom in Focus timeline"]')!
  // Preserve the actual latest read mode: entering historical mode is a separate native snapshot intent.
  await act(async()=>wider.click());await act(async()=>narrower.click())
  expect(h.history.mock.calls.length).toBe(reads);expect(h.observe.mock.calls.length).toBe(observes)
  expect(h.node.querySelector('[data-message-id]')).not.toBeNull()
})
