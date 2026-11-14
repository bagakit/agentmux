// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { savedQuestionEvent, savedQuestionReply, savedQuestionSource, savedQuestionAnswer } from '../../../packages/core/test/helpers/codex-saved-question'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { consumeConversationWindowPage, type ConversationWindowAssembly, type ConversationWindowSnapshot } from '@agentmux/core/conversation'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'

// Paint/input leaves are outside this read-demand check. SessionPane, Activity,
// shared presentation, Provider, Core Reader and its original observations are real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: ({ sessionId }: { sessionId: string }) => <textarea data-draft defaultValue={useAppStore.getState().agentComposerDrafts[sessionId]} /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: () => null }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('../src/renderer/src/components/StableWorkbenchView', () => ({ StableWorkbenchView: ({ children }: { children: ReactNode }) => children }))
vi.mock('../src/renderer/src/lib/reading-diagnostic-publication', () => ({ publishReadingDiagnostic: () => {} }))

const initial = useAppStore.getState(), copy = vi.fn(async () => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
const cleanups: Array<() => unknown | Promise<unknown>> = []
const factsPath = process.env.ARCH_READER_009_FACTS
async function note(value: unknown) { if (factsPath) await appendFile(factsPath, JSON.stringify(value) + '\n') }
async function until(condition: () => boolean, message = 'Actual reading must settle') {
  for (let i = 0; i < 400 && !condition(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  expect(condition(), message).toBe(true)
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { release, promise } }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  localStorage.clear(); copy.mockClear()
  const environment = await mkdtemp('/tmp/amx-context-')
  await note({ kind: 'environment-created', path: environment })
  cleanups.push(async () => { await rm(environment, { recursive: true, force: true }); await note({ kind: 'environment-removed', path: environment }) })
  isolateCoreFixtureEnvironment(environment)
})
afterEach(async () => {
  getSelection()?.removeAllRanges()
  const failures: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { failures.push(error) }
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear()
  if (failures.length) throw new AggregateError(failures, 'Owned conversation context cleanup failed')
})
async function fixture(question = false) {
  const data = question ? jsonl([savedQuestionEvent(),
    ...Array.from({ length: 1205 }, (_, n) => ({ timestamp: new Date(1_500_000_000_000 + n * 172_800_000).toISOString(), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'recorded-turn-' + n } })),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', id: 'readable-tail',
      content: [{ type: 'output_text', text: 'Original readable tail.' }] } }])
    : jsonl([{ type: 'user', uuid: 'input-native', sessionId: 'native-main', message: { role: 'user', content: 'Original human input.' } },
      { type: 'assistant', uuid: 'reply-native', sessionId: 'native-main', message: { role: 'assistant', content: 'Original readable reply.' } }])
  const f = await nativeHistoryFixture(question ? 'codex' : 'claude', question
    ? root => jsonl([{ type: 'session_meta', payload: { id: savedQuestionSource.nativeSessionId, cwd: root } }]) + data
    : data, question ? { nativeSessionId: savedQuestionSource.nativeSessionId } : {})
  await note({ kind: 'fixture-created', path: f.root })
  cleanups.push(async () => { await f.close(); await note({ kind: 'fixture-removed', path: f.root }) })
  cleanups.push(async () => {
    expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
    expect(await f.store.readMetadata(f.session.agentSessionId)).toEqual(f.session)
    if (!question) expect(await readFile(f.path)).toEqual(f.before.native)
  })
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }], executors: {},
    workspaces: [{ id: 'ws', hostId: 'local', path: f.root, name: 'Typed project', kind: 'folder' }], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = { id: f.session.agentSessionId, kind: 'agent', hostId: 'local', workspacePath: f.root,
    label: 'Original Agent', providerId: f.session.providerId, executorId: f.session.executorId, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0, promptSubmissionPredecessor: null,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    nativeHandle: f.session.nativeHandle, control: { kind: 'agent', hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run } }
  const peer = { ...session, id: 'typed-peer', label: 'Original peer', control: { ...session.control, agentSessionId: 'typed-peer' } }
  useAppStore.setState({ config, sessions: [session, peer], pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
    viewModes: { [session.id]: 'activity' }, timelines: {}, agentNames: {}, agentComposerDrafts: { [session.id]: 'UNSENT_DRAFT' }, agentSteerQueues: {} })
  if (!question) await f.store.applyTimelineMutation({ type: 'append', agentSessionId: session.id, item: { id: 'peer-input', agentSessionId: session.id,
    kind: 'user_message', source: 'user', status: 'complete', title: 'Original peer input', content: 'Typed peer body.', authorAgentSessionId: peer.id, createdAt: 2, updatedAt: 2 } })
  const calls: Parameters<typeof f.client.readAgentConversation>[0][] = [], watches: Array<{ view: string | null; disposed: boolean }> = []
  const read = vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation(async (input, options) => { calls.push(input); return f.client.readAgentConversation(input, options) })
  vi.spyOn(api.conversation, 'readConversationChanges').mockImplementation((...args) => f.client.readConversationChanges(...args))
  vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation((...args) => f.client.releaseConversationView(...args))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation(async (...args) => {
    const handle = await f.client.observeConversation(...args)
    const entry = { view: args[0].view ?? null, disposed: false }; watches.push(entry)
    return { ...handle, dispose() { entry.disposed = true; return handle.dispose() } }
  })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  cleanups.push(async () => { await note({ kind: 'final-reader-state', starts: calls, watches, text: host.textContent, html: host.innerHTML.slice(0, 12000) }); await act(async () => root.unmount()); host.remove() })
  const pane = (key: string, visible = true) => <SessionPane key={key} sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={visible}
    linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: key, regionId: key }} />
  const render = (keys = ['one'], visible = true, hidden: readonly string[] = []) => act(async () => root.render(<ClientUiProvider platform={platform}>{keys.map(key => pane(key, visible && !hidden.includes(key)))}</ClientUiProvider>))
  return { ...f, host, root, session, calls, watches, read, render, sourceViews: () => watches.filter(entry => !entry.view && !entry.disposed),
    exactViews: () => watches.filter(entry => entry.view && !entry.disposed), starts: () => calls.filter(input => !input.cursor && !input.view && !input.record && !input.anchor) }
}

it('uses the one real Activity Reader for current inputs and speaker updates, preserving body, selection, Copy and draft', async () => {
  const f = await fixture(); await f.render()
  await until(() => f.host.textContent!.includes('Original readable reply.') && f.host.textContent!.includes('Original peer') && f.exactViews().length > 0)
  expect(f.starts(), 'SessionPane must not start a second complete summary Reader').toHaveLength(1)
  expect(f.watches.filter(entry => !entry.view)).toHaveLength(1); expect(f.sourceViews()).toHaveLength(0); expect(f.exactViews()).toHaveLength(1)
  const body = [...f.host.querySelectorAll<HTMLElement>('.log-turn__body')].find(node => node.textContent!.includes('Original readable reply.'))!
  expect(body).toBeDefined()
  const text = body.querySelector('.md-paragraph')?.firstChild ?? body.querySelector('.log-turn__text')!.firstChild!
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 8); getSelection()!.addRange(range)
  const draft = f.host.querySelector('textarea[data-draft]')!
  await act(async () => useAppStore.setState(state => ({ agentNames: { ...state.agentNames, 'typed-peer': 'Renamed peer' } })))
  await until(() => f.host.textContent!.includes('Renamed peer'))
  expect(f.host.contains(body)).toBe(true); expect(getSelection()!.toString()).toBe('Original'); expect(getSelection()!.anchorNode).toBe(text)
  expect(f.host.querySelector('textarea[data-draft]')).toBe(draft); expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('UNSENT_DRAFT')
  await act(async () => body.closest('.log-turn')!.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenCalledWith('Original readable reply.', expect.any(Function)); expect(f.starts()).toHaveLength(1)
  await note({ kind: 'current-workface', starts: f.starts(), sourceObservers: f.sourceViews().length, exactObservers: f.exactViews().length, controls: [], draft: 'UNSENT_DRAFT' })
})

it('keeps separate actual workfaces and disposes only the departing Reader', async () => {
  const f = await fixture(); await f.render(['one', 'two'])
  await until(() => f.exactViews().length === 2 && f.host.querySelectorAll('.activity-feed').length === 2)
  expect(f.starts()).toHaveLength(2); expect(f.watches.filter(entry => !entry.view)).toHaveLength(2)
  const remaining = f.host.querySelectorAll('.activity-feed')[1]!
  const parked = f.host.querySelector('.activity-feed')!
  await f.render(['one', 'two'], true, ['one'])
  await until(() => f.exactViews().length === 1)
  expect(f.host.querySelector('.activity-feed')).toBe(parked); expect(f.starts()).toHaveLength(2)
  await f.render(['one', 'two']); await until(() => f.exactViews().length === 2)
  expect(f.host.querySelector('.activity-feed')).toBe(parked); expect(f.starts()).toHaveLength(2)
  await f.render(['two']); await until(() => f.exactViews().length === 1 && f.sourceViews().length === 0)
  expect(f.host.querySelector('.activity-feed')).toBe(remaining); expect(f.starts()).toHaveLength(2)
  await note({ kind: 'independent-workfaces', starts: f.starts().length, remainingExactObservers: f.exactViews().length, controls: [] })
})

it('opens current answer context only after a real historical question is accepted, through the same public Core source', async () => {
  const f = await fixture(true)
  // The original Provider supplies the opaque record identity; the private
  // navigation intent below only selects that known record in this workface.
  let page = await f.client.sessionHistoryPage(f.session.id, { limit: 100 }), lookups = 1
  let question = page.items.find(item => item.questionRequest)
  while (!question && page.nextCursor && lookups < 16) {
    page = await f.client.sessionHistoryPage(f.session.id, { limit: 100, cursor: page.nextCursor }); lookups++
    question = page.items.find(item => item.questionRequest)
  }
  expect(question).toBeDefined()
  await f.render()
  await until(() => f.exactViews().length === 1 && f.host.textContent!.includes('Original readable tail.'))
  expect(f.starts()).toHaveLength(1)
  const waiting = gate(), read = f.client.readAgentConversation.bind(f.client)
  let historicalReady = false, failAnswers = true, historicalFrame: ConversationWindowSnapshot | undefined, pending: ConversationWindowAssembly | undefined
  f.read.mockImplementation(async (input, options) => {
    f.calls.push(input)
    if (historicalReady && failAnswers && !input.cursor && !input.record && !input.view) throw new Error('Controlled current answer context unavailable')
    const page = await read(input, options)
    if ((input.record || input.cursor) && !historicalReady) {
      const consumed = consumeConversationWindowPage(page, pending)
      if (consumed.kind === 'pending') pending = consumed.pending
      else { historicalReady = true; historicalFrame = consumed.snapshot; await waiting.promise }
    }
    return page
  })
  try {
    await act(async () => useAppStore.setState({ conversationRevealIntent: {
      itemRef: { hostId: 'local', agentSessionId: f.session.id, source: { kind: 'native', ...page.source, recordId: question!.id } }, routeHostId: 'local',
      reference: { displayWorkspaceId: 'ws', groupId: 'group', tabId: 'one', regionId: 'one' },
      claimed: false, isCurrent: () => true, complete: () => {}
    } }))
    await until(() => historicalReady)
    expect(historicalFrame!.units.some(unit => unit.records.some(record => record.original.kind === 'native' && record.original.item.questionRequest))).toBe(true)
    expect(historicalFrame!.window.navigation.newer).toBeTypeOf('string')
    await appendFile(f.path, jsonl([savedQuestionReply()]))
    waiting.release()
    await until(() => f.host.textContent!.includes('Controlled current answer context unavailable'))
    const card = f.host.querySelector('[aria-label="Native asynchronous question"]')!
    expect(card).not.toBeNull(); expect(card.getAttribute('data-question-state')).toBe('unknown')
    const issue = f.host.querySelector<HTMLElement>('.activity-feed__reading-service')!
    expect(issue).toBeDefined()
    expect(issue.querySelector('[aria-label="Current question answers"]')?.textContent).toContain('Controlled current answer context unavailable')
    await note({ kind: 'question-answer-failure', originalRecordId: question!.id, html: issue.outerHTML, questionRetained: true, controls: [] })
    failAnswers = false
    const retry = issue.querySelector<HTMLButtonElement>('[aria-label="Retry reading"]')!
    expect(retry).toBeDefined(); await act(async () => retry.click())
    await until(() => f.host.querySelector('[aria-label="Native asynchronous question"]')?.getAttribute('data-question-state') === 'answered')
    expect(f.host.querySelector('[aria-label="Native asynchronous question"]')).toBe(card)
    expect(f.host.querySelector('.agent-question__answer')?.textContent).toBe(savedQuestionAnswer)
    await until(() => f.sourceViews().length === 0 && f.exactViews().length === 2)
    expect(f.starts()).toHaveLength(3); expect(f.watches.filter(entry => !entry.view)).toHaveLength(3)
    expect(f.sourceViews()).toHaveLength(0); expect(f.exactViews()).toHaveLength(2)
    expect(f.calls.every(input => input.agentSessionId === f.session.id)).toBe(true)
    await note({ kind: 'historical-question', initialLatestStarts: 1, finalLatestStarts: f.starts().length, failedContextAttempts: 1, successfulReaders: 2,
      source: savedQuestionSource, answer: savedQuestionAnswer, originalRecordId: question!.id, lookupPages: lookups,
      historicalView: historicalFrame!.window.id, newerNavigation: historicalFrame!.window.navigation.newer, controls: [] })
  } finally { waiting.release() }
})
