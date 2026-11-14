// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import type { DesktopQuestionReplyAttempt } from '../src/renderer/src/lib/conversation-question-intent'
import { questionRefusalEvent } from './helpers/question-refusal-fixture'

let root: string
let dispose: (() => void) | undefined
beforeEach(async () => { vi.resetModules(); window.localStorage.clear(); root = await mkdtemp(join(tmpdir(), 'amux-user-state-consumer-')) })
afterEach(async () => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }) })

async function fixture(initial = 'Original unsent draft', unreadable = false, question?: { attempt: DesktopQuestionReplyAttempt; beforeSnapshot?: boolean }) {
  const { useAppStore: store } = await import('../src/renderer/src/store')
  const { api } = await import('../src/renderer/src/lib/api')
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  const { desktopSpatialGraph } = await import('../src/renderer/src/lib/desktop-spatial-state')
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private storage proof' }], executors: {},
    workspaces: [{ id: 'original-workspace', name: 'Private proof', hostId: 'local', path: root, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: SessionSnapshot = { id: 'original-agent', kind: 'agent', providerId: 'codex', executorId: 'original-executor',
    hostId: 'local', workspacePath: root, label: 'Original Agent', createdAt: 1, updatedAt: 1, processState: 'running', agentSessionUpdatedAt: 1, promptSubmissionPredecessor: null,
    status: { state: 'working', source: 'native-hook', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-agent', run: { runId: 'original-run' } } }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'original-workspace', sessionId: session.id })
  store.setState({ config, tabs: { [tab.id]: tab }, layouts: { 'original-workspace': createWorkspaceLayout('original-group', [tab.id]) },
    sessions: [session], activeWorkspaceId: 'original-workspace', agentComposerDrafts: {} })
  const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial-state.json'))
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(store.getState(), []) })
  const user = new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
  if (question) {
    const key = questionReplyKey(session.id, question.attempt.input)
    await user.write(JSON.stringify({ state: { agentComposerDrafts: { 'original-region': initial }, questionReplies: { [session.id]: { [key]: question.attempt } },
      questionReplyDrafts: { [session.id]: { [key]: [{ questionId: 'original-q', answer: 'Later edited draft stays separate' }] } } }, version: 1 }))
    if (question.beforeSnapshot) session.promptInputNotApplied = { submissionId: question.attempt.input.operationId, run: session.control.run }
  }
  window.localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ state: { agentComposerDrafts: { 'original-region': initial } }, version: 1 }))
  if (unreadable) await user.write(JSON.stringify({ state: { agentComposerDrafts: { 'original-region': initial } }, version: 1 }))
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => unreadable ? Promise.reject(Error('Original read unavailable')) : user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(value => user.importIfAbsent(value))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => user.write(value))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
  if (question) { vi.spyOn(api.sessions, 'replyQuestion'); vi.spyOn(api.sessions, 'submitPrompt') }
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(value => spatial.commit(value))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  dispose = await store.getState().initialize()
  return { store, api, user, spatial, session, repairRead: () => { unreadable = false } }
}

const questionInput = { source: { providerId: 'codex', nativeSessionId: 'original-native' }, turnId: 'original-turn', recordId: 'original-question',
  operationId: 'original-question-op', expectedRun: { runId: 'original-run' }, afterSubmissionId: null, answers: [{ questionId: 'original-q', answer: 'Original frozen answer 中文' }] }
const unknownQuestion: DesktopQuestionReplyAttempt = { hostId: 'local', phase: 'unknown', input: questionInput, diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'Original uncertainty' } }

it('question owner settles actual Store ingress with no Pane and persists the original refusal', async () => {
  const f = await fixture('Original unsent draft', false, { attempt: unknownQuestion })
  const key = questionReplyKey(f.session.id, questionInput), original = f.store.getState().questionReplies[f.session.id]![key]!
  expect(original.phase).toBe('unknown')
  f.store.getState().applyEvent(questionRefusalEvent(f.session as Extract<SessionSnapshot, { kind: 'agent' }>, questionInput.operationId))
  expect(f.store.getState().questionReplies[f.session.id]![key]?.phase, 'No mounted Pane is required to settle the original refusal').toBe('rejected')
  await vi.waitFor(async () => expect(JSON.parse((await f.user.read())!).state.questionReplies[f.session.id][key].phase).toBe('rejected'))
  expect(f.store.getState().questionReplies[f.session.id]![key]?.input).toEqual(original.input)
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(f.store.getState().questionReplyDrafts[f.session.id]![key]).toEqual([{ questionId: 'original-q', answer: 'Later edited draft stays separate' }])
  expect(f.store.getState().sessions.find(s => s.id === f.session.id)?.control).toEqual(f.session.control)
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  expect(f.api.sessions.replyQuestion).not.toHaveBeenCalled(); expect(f.api.sessions.submitPrompt).not.toHaveBeenCalled()
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root }
  for (const name of Object.keys(env)) if (/^(AGENTMUX|AMUX|CTXMUX|CODEX)_/.test(name)) delete env[name]
  const reopened = JSON.parse(execFileSync(process.execPath, [resolve('apps/desktop/test/fixtures/question-owner-reopen.mjs'), f.user.path, root], { env, encoding: 'utf8' }))
  expect(reopened.pid).not.toBe(process.pid)
  expect(reopened.phase, 'A fresh private process reopens actual saved refusal without reseeding').toBe('rejected')
  expect(reopened.answers).toEqual(questionInput.answers)
  expect(reopened.operationId).toBe(questionInput.operationId)
  if (process.env.QUESTION_OWNER_FACTS) appendFileSync(process.env.QUESTION_OWNER_FACTS, JSON.stringify({ case: 'no-pane-native-save-reopen', reopened }) + '\n')
})

it('question owner converges bootstrap and intent-after-fact through the original writer', async () => {
  const f = await fixture('Original draft', false, { attempt: { ...unknownQuestion, phase: 'sending' }, beforeSnapshot: true })
  const key = questionReplyKey(f.session.id, questionInput)
  await vi.waitFor(() => expect(f.store.getState().questionReplies[f.session.id]![key]?.phase, 'Restored original intent settles from the accepted bootstrap without a Pane').toBe('rejected'))
  const { retainConversationQuestionReply } = await import('../src/renderer/src/store')
  const old = f.store.getState().questionReplies[f.session.id]![key]!
  await retainConversationQuestionReply(f.session.id, key, unknownQuestion, old)
  expect(f.store.getState().questionReplies[f.session.id]![key]?.phase, 'A late original unknown intent consumes the already accepted refusal').toBe('rejected')
  await vi.waitFor(async () => expect(JSON.parse((await f.user.read())!).state.questionReplies[f.session.id][key].phase).toBe('rejected'))
})

it('question owner consumes an accepted explicit refresh without a Pane or later Runtime event', async () => {
  const f = await fixture('Original draft', false, { attempt: unknownQuestion })
  const key = questionReplyKey(f.session.id, questionInput)
  vi.mocked(f.api.sessions.refresh).mockResolvedValue({ ...f.session, promptInputNotApplied: { submissionId: questionInput.operationId, run: f.session.control.run } } as SessionSnapshot)
  await f.store.getState().refreshSession(f.session.id)
  expect(f.store.getState().questionReplies[f.session.id]![key]?.phase, 'An accepted exact refresh must settle without waiting for a Pane or new event').toBe('rejected')
  await vi.waitFor(async () => expect(JSON.parse((await f.user.read())!).state.questionReplies[f.session.id][key].phase).toBe('rejected'))
  expect(f.api.sessions.replyQuestion).not.toHaveBeenCalled(); expect(f.api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it.each([
  ['wrong Host', { ...unknownQuestion, hostId: 'foreign-host' }],
  ['wrong Run', { ...unknownQuestion, input: { ...questionInput, expectedRun: { runId: 'old-run' } } }],
  ['wrong submission', { ...unknownQuestion, input: { ...questionInput, operationId: 'another-operation' } }],
  ['confirmed', { ...unknownQuestion, phase: 'confirmed' as const }],
  ['unreadable source', { ...unknownQuestion, input: { ...questionInput, source: { providerId: '', nativeSessionId: 'original-native' } } }]
])('question owner retains the exact original for %s', async (name, attempt) => {
  const f = await fixture('Original draft', false, { attempt })
  const key = questionReplyKey(f.session.id, attempt.input), original = f.store.getState().questionReplies[f.session.id]![key]
  f.store.getState().applyEvent(questionRefusalEvent(f.session as Extract<SessionSnapshot, { kind: 'agent' }>, questionInput.operationId))
  expect(f.store.getState().questionReplies[f.session.id]![key], 'A refusal must not settle a different original: ' + name).toBe(original)
})

it('question owner preserves the later attempt against stale CAS and does not repeat or scan unrelated intents', async () => {
  const f = await fixture('Original draft', false, { attempt: unknownQuestion })
  const owner = await import('../src/renderer/src/store'), matcher = await import('../src/renderer/src/lib/conversation-question-intent')
  const key = questionReplyKey(f.session.id, questionInput), original = f.store.getState().questionReplies[f.session.id]![key]!
  const later = { ...original, phase: 'confirmed' as const }
  await owner.retainConversationQuestionReply(f.session.id, key, later, original)
  const stale = await owner.retainConversationQuestionReply(f.session.id, key, { ...original, phase: 'rejected' }, original).then(() => null, (error: unknown) => error)
  expect(stale instanceof Error ? stale.message : null, 'Stale CAS cannot replace a later original attempt').toContain('record changed')
  expect(f.store.getState().questionReplies[f.session.id]![key]).toBe(later)
  const other = { ...f.session, id: 'unrelated-agent', control: { ...f.session.control, agentSessionId: 'unrelated-agent' } } as Extract<SessionSnapshot, { kind: 'agent' }>
  f.store.setState(state => ({ sessions: [...state.sessions, other] }))
  const match = vi.spyOn(matcher, 'rejectedQuestionReply'), parse = vi.spyOn(await import('@agentmux/client-ui/conversation-question-reply'), 'parseQuestionReplyAttempt'), writing = vi.mocked(f.api.ui.writeWorkbenchState)
  const writes = writing.mock.calls.length
  f.store.getState().applyEvent(questionRefusalEvent(other, 'unrelated-operation'))
  expect(match, 'Unrelated Session ingress must not inspect this original intent').not.toHaveBeenCalled()
  f.store.getState().applyEvent(questionRefusalEvent(f.session as Extract<SessionSnapshot, { kind: 'agent' }>, questionInput.operationId))
  f.store.getState().applyEvent(questionRefusalEvent(f.session as Extract<SessionSnapshot, { kind: 'agent' }>, questionInput.operationId))
  await new Promise(done => setTimeout(done, 450))
  expect(writing.mock.calls.length, 'Already settled and unrelated facts do not submit another native user write').toBe(writes)
  expect(parse, 'Already settled facts do not parse or clone retained answer inputs').not.toHaveBeenCalled()
  expect(f.store.getState().questionReplies[f.session.id]![key]).toBe(later)
})

it('question owner keeps content and reports original save failure without claiming on-disk settlement', async () => {
  const f = await fixture('Original unsent draft', false, { attempt: unknownQuestion })
  const key = questionReplyKey(f.session.id, questionInput), writer = vi.mocked(f.api.ui.writeWorkbenchState)
  writer.mockRejectedValue(Error('Private refusal write unconfirmed'))
  f.store.getState().applyEvent(questionRefusalEvent(f.session as Extract<SessionSnapshot, { kind: 'agent' }>, questionInput.operationId))
  await vi.waitFor(() => expect(f.store.getState().workbenchSaveWarning).toContain('Private refusal write unconfirmed'))
  expect(f.store.getState().questionReplies[f.session.id]![key]?.phase).toBe('rejected')
  expect(f.store.getState().questionReplies[f.session.id]![key]?.input).toEqual(questionInput)
  expect(JSON.parse((await f.user.read())!).state.questionReplies[f.session.id][key].phase, 'Failed save does not claim a new durable result').toBe('unknown')
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(f.store.getState().sessions.find(s => s.id === f.session.id)?.processState).toBe('running')
  writer.mockImplementation(value => f.user.write(value))
  await (await import('../src/renderer/src/store')).prepareRendererUpdate('quit')
  expect(JSON.parse((await f.user.read())!).state.questionReplies[f.session.id][key].phase).toBe('rejected')
})

it('actual Desktop hydration and user editing use the host file and preserve original spatial and Run identities', async () => {
  const f = await fixture()
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(window.localStorage.getItem('agentmux-workbench-v1')).toBeNull()
  f.store.getState().setAgentComposerDraft('original-region', 'Latest original draft')
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  const saved = JSON.parse(await readFile(join(root, 'workbench-user-state.json'), 'utf8'))
  expect(saved.state.agentComposerDrafts['original-region']).toBe('Latest original draft')
  expect(saved.state.restoredWorkbench).toBeUndefined()
  expect((await f.spatial.read())!.graph.regions.find(region => region.regionId === 'original-region')).toMatchObject({ agentSessionId: 'original-agent', runId: 'original-run' })
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  expect(f.user.observe().lastConfirmedWrite?.diskDurability).toBe('confirmed')
})

it('a failed native user save leaves the latest draft and healthy original Agent available for retry', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  f.store.getState().setAgentComposerDraft('original-region', 'Retain after save failure')
  vi.mocked(f.api.ui.writeWorkbenchState).mockRejectedValueOnce(Error('Private native write unconfirmed'))
  await expect(prepareRendererUpdate('quit')).rejects.toThrow('Private native write unconfirmed')
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Retain after save failure')
  expect(f.store.getState().sessions.find(session => session.id === 'original-agent')?.processState).toBe('running')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
  await prepareRendererUpdate('quit')
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['original-region']).toBe('Retain after save failure')
})

it('an explicit checkpoint resaves current user content after the original host file disappears', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  await unlink(f.user.path)
  await prepareRendererUpdate('quit')
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})

it('native user persistence waiting does not block an exactly bound healthy prompt', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.mocked(f.api.ui.writeWorkbenchState).mockImplementationOnce(async value => { await held; return f.user.write(value) })
  vi.spyOn(f.api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  try {
    expect(f.store.getState().send('original-agent', 'Exact original input')).toBe(true)
    await vi.waitFor(() => expect(f.api.sessions.submitPrompt).toHaveBeenCalledOnce())
    expect(vi.mocked(f.api.sessions.submitPrompt).mock.calls[0]!.slice(0, 3)).toEqual([f.session.control, 'Exact original input', expect.any(String)])
    expect(f.api.sessions.stop).not.toHaveBeenCalled()
  } finally {
    release?.()
    await prepareRendererUpdate('quit')
  }
})

it('unrelated Session output updates do not submit native user or spatial writes', async () => {
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  vi.mocked(f.api.ui.writeWorkbenchState).mockClear()
  vi.mocked(f.api.spatial.commit).mockClear()
  const unrelated = Array.from({ length: 500 }, (_, index) => ({ ...f.session, id: 'unrelated-' + index,
    control: { ...f.session.control, agentSessionId: 'unrelated-' + index } }))
  for (let tick = 1; tick <= 100; tick++) {
    f.store.setState({ sessions: [f.session, ...unrelated.map(session => ({ ...session, latestOutputBytes: tick }))] })
  }
  await new Promise(resolve => setTimeout(resolve, 450))
  expect(f.api.ui.writeWorkbenchState).not.toHaveBeenCalled()
  expect(f.api.spatial.commit).not.toHaveBeenCalled()
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Original unsent draft')
})

it('an actual public spatial mutation producer confirms both native owners with the client-state receipt', async () => {
  const f = await fixture(), original = (await f.spatial.read())!.graph.bindings[0]!
  const result = await f.store.getState().executeControl({ schemaVersion: 5, requestId: 'original-unbind', operation: 'space.unbind',
    binding: { kind: 'zone-space', ...original } })
  expect(result).toMatchObject({ operation: 'space.unbind', outcome: 'unlinked',
    save: { layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'confirmed', reason: null } })
  expect((await f.spatial.read())!.graph.bindings).not.toContainEqual(original)
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['original-region']).toBe('Original unsent draft')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})


it('the actual Store registers a best-effort unload callback that submits pending input to the native owner', async () => {
  const registrations = vi.spyOn(window, 'addEventListener')
  const f = await fixture()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  const handler = registrations.mock.calls.find(call => call[0] === 'pagehide')?.[1]
  expect(handler).toBeTypeOf('function')
  // Use this exact registered callback on an isolated event target: earlier module
  // instances in this test environment must not receive another instance's exit.
  const events = new EventTarget()
  events.addEventListener('pagehide', handler as EventListener)
  const realSetTimeout = globalThis.setTimeout.bind(globalThis), realClearTimeout = globalThis.clearTimeout.bind(globalThis)
  let deadline: ReturnType<typeof setTimeout> | undefined, entered = false, start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  vi.mocked(f.api.ui.writeWorkbenchState).mockImplementation(value => { entered = true; start(); return f.user.write(value) })
  vi.useFakeTimers()
  try {
    f.store.getState().setAgentComposerDraft('original-region', 'Pending input delivered by unload')
    events.dispatchEvent(new Event('pagehide'))
    await Promise.race([started, new Promise<void>(resolve => { deadline = realSetTimeout(resolve, 1000) })])
    expect(entered).toBe(true)
    expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts['original-region']).toBe('Pending input delivered by unload')
  } finally { realClearTimeout(deadline); vi.useRealTimers() }
})


it.each(['composer', 'queue', 'editor'])('fenced Quit keeps actual %s input while startup defaults alone can quit', async kind => {
  const f = await fixture('Original protected bytes', true)
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  const original = await readFile(f.user.path, 'utf8')
  await expect(prepareRendererUpdate('quit')).resolves.toBeUndefined()
  if (kind === 'composer') f.store.getState().setAgentComposerDraft('original-region', 'New authored root draft')
  if (kind === 'queue') {
    expect(f.store.getState().enqueueAgentSteer('original-agent', 'New authored queued input')).not.toBe(false)
    expect(f.store.getState().agentSteerQueues['original-agent']?.at(-1)?.text).toBe('New authored queued input')
  }
  if (kind === 'editor') {
    const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
    const tab = createWorkbenchTab('original-file-tab', { kind: 'file', regionId: 'original-file-region', workspaceId: 'original-workspace', path: 'draft.txt' })
    f.store.setState(state => ({ tabs: { ...state.tabs, [tab.id]: tab }, documents: { ...state.documents, ['original-workspace\0draft.txt']: { path: 'draft.txt', content: 'Original file', revision: 'original-revision' } } }))
    f.store.getState().updateDocument(tab.id, 'New authored file buffer')
    expect(f.store.getState().documents['original-workspace\0draft.txt']?.content).toBe('New authored file buffer')
  }
  await expect(prepareRendererUpdate('quit')).rejects.toThrow('Current Desktop input is not yet saved')
  expect(await readFile(f.user.path, 'utf8')).toBe(original)
  if (kind === 'composer') expect(f.store.getState().agentComposerDrafts['original-region']).toBe('New authored root draft')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})


it('repairing the original read merges disjoint real early edits before opening the original writer', async () => {
  const f = await fixture('Original protected bytes', true)
  f.store.getState().setAgentComposerDraft('new-original-region', 'New authored text during failed read')
  f.repairRead(); dispose?.(); dispose = await f.store.getState().initialize()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await prepareRendererUpdate('quit')
  expect(JSON.parse((await f.user.read())!).state.agentComposerDrafts).toEqual({
    'original-region': 'Original protected bytes', 'new-original-region': 'New authored text during failed read' })
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})

it('repairing an overlapping unread input preserves both the original file and current authored draft', async () => {
  const f = await fixture('Unknown original saved text', true), original = await readFile(f.user.path, 'utf8')
  f.store.getState().setAgentComposerDraft('original-region', 'Current new text cannot silently replace unseen text')
  f.repairRead(); dispose?.(); dispose = await f.store.getState().initialize()
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await expect(prepareRendererUpdate('quit')).rejects.toThrow('Current Desktop input is not yet saved')
  // Independently readable fragments may checkpoint this same document. The
  // original root input remains exact while the conflicting current edit stays live.
  expect(JSON.parse((await f.user.read())!).state).toEqual(JSON.parse(original).state)
  expect(f.store.getState().agentComposerDrafts['original-region']).toBe('Current new text cannot silently replace unseen text')
  expect(f.api.sessions.stop).not.toHaveBeenCalled()
})
