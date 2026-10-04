// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { createMoteApp, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { neighborAgent, neighborTab, customAgent, customTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { beginMoteStartupRecovery, deferScratchConversationRecovery, recoverMoteConversationAtStartup, recoverScratchConversationsAtStartup, useMoteConversationRecovery } from '../src/renderer/src/lib/mote-session-recovery'
import { PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { parseMoteQuickMode, serializeMoteQuickMode, type MoteQuickDefaults } from '../src/shared/mote-quick-mode'
import type { ScratchTopicSnapshot, SessionRecoveryResult } from '../src/shared/contracts'

let app: MoteAppFixture, cleanupStartup: () => void
const originalStop = useAppStore.getState().stopSession
const originalRecover = useAppStore.getState().recoverSession
const ref = { hostId: 'local', sessionId: neighborAgent.id, displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: neighborTab.id, regionId: 'neighbor-region' }
const ended = { ...neighborAgent, processState: 'exited' as const }
function setTopics(topics: ScratchTopicSnapshot[], options: { reading?: boolean; error?: string | null } = {}) {
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, error: options.error ?? null, reading: options.reading ?? false } } })
}
function preferences(defaults: MoteQuickDefaults = { conversation: ref }) {
  const topics = moteTopics.map(topic => ({ ...topic, quickMode: topic.id === PMO_TEAMS_TOPIC_ID ? { status: 'saved' as const, defaults, version: 'fixture' } : { status: 'missing' as const } }))
  setTopics(topics); return topics
}
function Hook({ opened = true, id = PMO_TEAMS_TOPIC_ID }: { opened?: boolean; id?: string }) {
  const topic = useAppStore(state => state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.find(item => item.id === id))
  useMoteConversationRecovery(topic, SCRATCH_WORKSPACE_ID, opened); return null
}
let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
async function render(opened = true, twice = false) {
  await act(async () => root.render(createElement('div', null, createElement(Hook, { opened }), twice ? createElement(Hook, { opened }) : null)))
  await settleMoteApp()
}
beforeEach(() => {
  app = createMoteApp(); cleanupStartup = beginMoteStartupRecovery()
  useAppStore.setState({ stopSession: originalStop, recoverSession: originalRecover, sessions: useAppStore.getState().sessions.map(s => s.id === ended.id ? ended : s) })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'resumed', session: { ...neighborAgent, id: neighborAgent.control.agentSessionId, control: { ...neighborAgent.control, run: { runId: 'resumed-run' } } } })
  vi.spyOn(api.sessions, 'stop').mockResolvedValue(undefined)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); cleanupStartup(); await app.dispose() })
describe('original Mote conversation recovery', () => {
  it('preserves portable policy, body, unknown YAML and absence; rejects invalid timing', () => {
    const content = '---\nversion: 1\ndefaults: {executorId: fixture}\nother: retained\n---\nMy notes.\n'
    const saved = serializeMoteQuickMode(content, { executorId: 'fixture', recovery: 'startup' })
    expect(parseMoteQuickMode(saved)).toEqual({ status: 'valid', defaults: { executorId: 'fixture', recovery: 'startup' } })
    expect(saved).toContain('My notes.'); expect(saved).toContain('other: retained'); expect(serializeMoteQuickMode(saved, { executorId: 'fixture', recovery: 'startup' })).toBe(saved)
    expect(parseMoteQuickMode(content)).toEqual({ status: 'valid', defaults: { executorId: 'fixture' } })
    expect(parseMoteQuickMode(saved.replace('startup', 'always')).status).toBe('unconfirmed')
  })
  it('recovers the original conversation without focus, layout, draft or prompt mutation', async () => {
    preferences(); const before = useAppStore.getState(); await render()
    expect(api.sessions.recover).toHaveBeenCalledTimes(1); expect(api.sessions.recover).toHaveBeenCalledWith(ended.control, ended.workspacePath, expect.any(String))
    const after = useAppStore.getState()
    expect(after.sessions.find(s => s.id === ended.id)?.control.run.runId).toBe('resumed-run')
    expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(after.activeWorkspaceId).toBe(before.activeWorkspaceId); expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  })
  it('does not recover preview/hidden surfaces, healthy Runs or a foreign occurrence', async () => {
    preferences(); await render(false); expect(api.sessions.recover).not.toHaveBeenCalled()
    preferences({ conversation: { ...ref, groupId: 'foreign-group' } }); await render(); expect(api.sessions.recover).not.toHaveBeenCalled()
    await render(false); preferences(); useAppStore.setState({ sessions: useAppStore.getState().sessions.map(s => s.id === ended.id ? neighborAgent : s) }); await render()
    expect(api.sessions.recover).not.toHaveBeenCalled()
  })
  it('settles initially unconfirmed directory and Session authority within the original open', async () => {
    const topics = preferences(); setTopics(topics.map(t => t.id === PMO_TEAMS_TOPIC_ID ? { ...t, quickMode: { status: 'unconfirmed', message: 'Reading' } } : t), { reading: true })
    await render(); expect(api.sessions.recover).not.toHaveBeenCalled()
    await act(async () => setTopics(topics)); await settleMoteApp(); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('Stop before late configuration cancels this open but a later genuine open can reconnect', async () => {
    const topics = preferences(); setTopics(topics.map(t => t.id === PMO_TEAMS_TOPIC_ID ? { ...t, quickMode: { status: 'unconfirmed', message: 'Reading' } } : t), { reading: true })
    await render(); await useAppStore.getState().stopSession(ended.id)
    await act(async () => setTopics(topics)); await settleMoteApp(); expect(api.sessions.recover).not.toHaveBeenCalled()
    await render(false); await render(); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('late first directory facts can settle the captured startup without a retry sweep', async () => {
    preferences(); const topics = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!
    useAppStore.setState({ scratchTopicSnapshots: {} }); await recoverScratchConversationsAtStartup(); expect(api.sessions.recover).not.toHaveBeenCalled()
    setTopics([...topics]); await recoverMoteConversationAtStartup(ended); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    await recoverMoteConversationAtStartup(ended); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('keeps known missing configuration inert after Save until the next genuine open', async () => {
    preferences({}); await render(); await act(async () => preferences()); await settleMoteApp()
    expect(api.sessions.recover).not.toHaveBeenCalled(); await render(false); await render(); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('latches A to B to A and converges two actual open consumers through one request', async () => {
    preferences(); let resolve!: (result: SessionRecoveryResult) => void
    vi.mocked(api.sessions.recover).mockImplementation(() => new Promise(done => { resolve = done }))
    await render(true, true); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    await act(async () => { preferences({ conversation: { ...ref, tabId: 'missing' } }); preferences() })
    await act(async () => resolve({ kind: 'resumed', session: { ...neighborAgent, control: { ...neighborAgent.control, run: { runId: 'late-run' } } } }))
    expect(useAppStore.getState().sessions.find(s => s.id === ended.id)?.control.run.runId).toBe(ended.control.run.runId)
    await settleMoteApp(); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('one caller closing leaves the other original binding eligible', async () => {
    preferences(); let resolve!: (result: SessionRecoveryResult) => void
    vi.mocked(api.sessions.recover).mockImplementation(() => new Promise(done => { resolve = done }))
    await render(true, true); await render(true, false)
    await act(async () => resolve({ kind: 'resumed', session: { ...neighborAgent, control: { ...neighborAgent.control, run: { runId: 'shared-run' } } } }))
    expect(api.sessions.recover).toHaveBeenCalledTimes(1); expect(useAppStore.getState().sessions.find(s => s.id === ended.id)?.control.run.runId).toBe('shared-run')
  })
  it('explicit Stop cancels the intent and stops the canonical resumed Run exactly once', async () => {
    preferences(); let resolve!: (result: SessionRecoveryResult) => void
    const resumed = { ...neighborAgent, control: { ...neighborAgent.control, run: { runId: 'stop-new-run' } } }
    vi.mocked(api.sessions.recover).mockImplementation(() => new Promise(done => { resolve = done }))
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(resumed)
    await render(); const stopping = useAppStore.getState().stopSession(ended.id)
    await act(async () => resolve({ kind: 'resumed', session: resumed })); await stopping
    expect(api.sessions.stop).toHaveBeenCalledWith(resumed.control)
    await recoverScratchConversationsAtStartup(); await recoverMoteConversationAtStartup(ended)
    expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('keeps renderer aliases and authentic Core/Host identities through original recovery', async () => {
    preferences({ conversation: { ...ref, sessionId: 'durable-sid' } })
    const alias = { ...ended, control: { ...ended.control, agentSessionId: 'durable-sid' } }
    useAppStore.setState({ sessions: useAppStore.getState().sessions.map(s => s.id === ended.id ? alias : s) })
    vi.mocked(api.sessions.recover).mockResolvedValue({ kind: 'resumed', session: { ...neighborAgent, id: 'durable-sid', control: { ...alias.control, run: { runId: 'alias-run' } } } })
    await render(); expect(useAppStore.getState().sessions.find(s => s.id === ended.id)?.control.agentSessionId).toBe('durable-sid')
    expect(useAppStore.getState().tabs[neighborTab.id]?.regions['neighbor-region']).toMatchObject({ sessionId: ended.id })
    expect(deferScratchConversationRecovery(useAppStore.getState().tabs, useAppStore.getState().config, 'durable-sid', [alias])).toBe(true)
  })
  it.each(['retired', 'unavailable', 'conflict'] as const)('rejects a foreign %s response and retains the original healthy workface', async kind => {
    preferences(); vi.mocked(api.sessions.recover).mockResolvedValue({ kind, agentSessionId: 'foreign', previousRun: ended.control.run, evidence: { kind: 'run-missing' }, reason: 'unknown-session' } as SessionRecoveryResult)
    const before = useAppStore.getState(); await render()
    expect(useAppStore.getState().tabs).toBe(before.tabs); expect(useAppStore.getState().sessions).toBe(before.sessions)
    expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('another Agent Session') }), expect.anything())
  })
  it('does not let another directory error block this confirmed original conversation', async () => {
    const topics = preferences(); setTopics(topics.map(t => t.id === customAgent.id ? { ...t, readError: 'Unavailable sibling' } : t), { error: 'Unavailable sibling' })
    await render(); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  })
  it('mandatory Main startup and optional on-open respect the original startup cut and Stop', async () => {
    preferences({ conversation: ref, recovery: 'on-open' })
    await recoverScratchConversationsAtStartup(); expect(api.sessions.recover).toHaveBeenCalledTimes(1)
    vi.mocked(api.sessions.recover).mockClear(); cleanupStartup(); cleanupStartup = beginMoteStartupRecovery()
    const customRef = { ...ref, sessionId: customAgent.id, tabId: customTab.id, regionId: 'custom-region' }
    const topics = preferences({}); setTopics(topics.map(t => t.id === customTab.topicId ? { ...t, quickMode: { status: 'saved', defaults: { conversation: customRef }, version: 'custom' } } : t))
    const idle = { ...customAgent, processState: 'exited' as const, semanticStatus: { state: 'done' as const, source: 'native-hook', observedAt: Date.now(), stateEnteredAt: Date.now() } }
    useAppStore.setState({ sessions: useAppStore.getState().sessions.map(s => s.id === idle.id ? idle : s) })
    await recoverScratchConversationsAtStartup(); expect(api.sessions.recover).not.toHaveBeenCalled()
    await act(async () => setTopics(topics.map(t => t.id === customTab.topicId ? { ...t, quickMode: { status: 'saved', defaults: { conversation: customRef, recovery: 'startup' }, version: 'changed' } } : t)))
    await recoverMoteConversationAtStartup(idle); expect(api.sessions.recover).not.toHaveBeenCalled()
  })
})
