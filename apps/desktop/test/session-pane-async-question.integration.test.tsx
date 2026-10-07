// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch, fixturePath as _newTailFixturePath } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import { createClientUiRoot } from './helpers/client-ui-render'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import type { AgentSessionControl, AppConfig, SessionSnapshot } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: SessionSnapshot }) => <div data-terminal-session={session.id}/> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <textarea aria-label="Original composer"/> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({ onHistory }: { onHistory?: () => void }) => <header>{onHistory ? <button onClick={onHistory}>History</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
import { reconcileConversationQuestionReplies } from '../src/renderer/src/lib/conversation-question'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { desktopQuestionReplyState } from '../src/renderer/src/lib/conversation-question'
const original = useAppStore.getState(), control: AgentSessionControl = { kind: 'agent', hostId: 'original-host', agentSessionId: 'question-session', run: { runId: 'question-run' } }
const target = { source: { providerId: 'codex', nativeSessionId: 'question-native' }, turnId: 'question-turn', recordId: 'native-question' }
const page: AgentSessionHistoryPage = { agentSessionId: control.agentSessionId, source: target.source, nextCursor: null, items: [{ id: target.recordId, turnId: target.turnId, kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original question body' }], questionRequest: { delivery: 'async', questions: [ { id: 'first', prompt: 'Choose a direction', options: [{ id: 'keep', label: 'Keep original' }], acceptsText: true }, { id: 'second', prompt: 'Free text answer', options: [], acceptsText: true } ] } }] }
const key = questionReplyKey(control.agentSessionId, target)
const held = { hostId: control.hostId, phase: 'unknown' as const, diagnostic: { code: 'ORIGINAL_UNKNOWN', message: 'Original receipt remains unknown' }, input: { ...target, operationId: 'original-operation', expectedRun: control.run, afterSubmissionId: 'original-predecessor', answers: [{ questionId: 'first', answer: 'Original frozen answer' }] } }
let root: Root, container: HTMLDivElement
const pane = () => <SessionPane sessionId={control.agentSessionId} surfaceKind="agent" interactiveResize={false} visible readOnly={false} linkOrigin={{ workspaceId: 'ws', tabGroupId: 'group', tabId: 'tab', regionId: 'region' }}/>
async function flush() { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }
async function fill(field: HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })) }); await flush() }
function card() { const values = [...container.querySelectorAll<HTMLElement>('[aria-label="Native asynchronous question"]')].filter(node => !node.closest('[inert]')); expect(values).toHaveLength(1); return values[0]! }
async function click(selector: string) { await act(async () => card().querySelector<HTMLButtonElement>(selector)!.click()); await flush() }
async function setup(unknown = false) {
  const capabilities = new AgentProviderRegistry().catalog().find(provider => provider.id === 'codex')!.capabilities
  expect(capabilities.asyncQuestionReply).toBe('terminal')
  const config = { version: 9, hosts: [{ id: control.hostId, kind: 'local', label: 'Private host' }], executors: { codex: { label: 'Private reader', providerId: 'codex', command: 'unused', args: [], env: {}, injectAgentMuxGuide: true } }, workspaces: [{ id: 'ws', name: 'Project', hostId: control.hostId, path: _newTailFixturePath("private/project"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } } as AppConfig
  const session = { id: control.agentSessionId, kind: 'agent', hostId: control.hostId, workspacePath: _newTailFixturePath("private/project"), label: 'Original question agent', providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: _newTailFixtureEpoch(0, 0, 1), promptSubmissionPredecessor: null, nativeSessionId: target.source.nativeSessionId, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: target.source.nativeSessionId }, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1), processState: 'running', status: { state: 'done', source: 'native-hook', observedAt: _newTailFixtureEpoch(0, 0, 1) }, latestOutputBytes: 0, capabilities, control } as Extract<SessionSnapshot, { kind: 'agent' }>
  const focus = vi.fn(); useAppStore.setState({ config, sessions: [session], agentComposerDrafts: { [control.agentSessionId]: 'ORIGINAL UNSENT' }, viewModes: { [control.agentSessionId]: 'activity' }, timelines: {}, pendingAgentLaunches: {}, runtimeOwnershipWarnings: [], recoveryCandidates: [], agentSteerQueues: {}, questionReplies: unknown ? { [control.agentSessionId]: { [key]: structuredClone(held) } } : {}, questionReplyDrafts: {}, focusRegion: focus, workbenchSaveWarning: null })
  const reads = vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(page), send = vi.spyOn(api.sessions, 'replyQuestion'), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  const write = vi.spyOn(api.sessions, 'write'), resume = vi.spyOn(api.sessions, 'resume'), stop = vi.spyOn(api.sessions, 'stop')
  await act(async () => root.render(pane())); await flush(); return { reads, send, copy, focus, write, resume, stop }
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(original, true); vi.restoreAllMocks() })
it('actual SessionPane edits two answers, copies plain text and opens the same SID and Region then returns with drafts and unknown intact', async () => {
  const f = await setup(true), frozen = structuredClone(useAppStore.getState().questionReplies[control.agentSessionId]![key])
  await click('[data-question-id="first"] button'); await fill(card().querySelector('[aria-label="Your answer: Free text answer"]')!, '  第二题\n保留空白  ')
  await click('[aria-label="Copy answer: Free text answer"]'); expect(f.copy).toHaveBeenCalledExactlyOnceWith('  第二题\n保留空白  ')
  const drafts = structuredClone(useAppStore.getState().questionReplyDrafts), count = f.reads.mock.calls.length
  await click('.agent-question__footer button')
  expect(useAppStore.getState().viewModes[control.agentSessionId]).toBe('terminal')
  expect(container.querySelector('[data-terminal-session]')?.getAttribute('data-terminal-session')).toBe(control.agentSessionId)
  expect(f.focus).toHaveBeenCalledWith('ws', 'tab', 'region', 'pointer', 'group')
  await act(async () => useAppStore.getState().setViewMode(control.agentSessionId, 'activity')); await flush()
  expect(card().querySelector<HTMLTextAreaElement>('[aria-label="Your answer: Free text answer"]')!.value).toBe('  第二题\n保留空白  ')
  await act(async () => root.render(<div>Another surface</div>)); await act(async () => root.render(pane())); await flush()
  expect(useAppStore.getState().questionReplyDrafts).toEqual(drafts); expect(useAppStore.getState().questionReplies[control.agentSessionId]![key]).toEqual(frozen)
  expect(card().querySelector('.agent-question__original')?.textContent).toContain('original-predecessor'); expect(card().textContent).toContain('Original receipt remains unknown')
  expect(useAppStore.getState().agentComposerDrafts[control.agentSessionId]).toBe('ORIGINAL UNSENT')
  for (const action of [f.send, f.write, f.resume, f.stop]) expect(action).not.toHaveBeenCalled()
  expect(f.reads.mock.calls.length).toBeGreaterThanOrEqual(count); expect(f.reads.mock.calls.every(([target]) => target.agentSessionId === control.agentSessionId)).toBe(true)
})
it('actual Pane keeps clipboard and save failures visible without blocking drafts or terminal; late copy cannot mark another Host/Run/source', async () => {
  const f = await setup(); await fill(card().querySelector('[aria-label="Your answer: Free text answer"]')!, 'Plain answer')
  f.copy.mockRejectedValueOnce(new Error('Clipboard unavailable')); await click('[aria-label="Copy answer: Free text answer"]'); expect(card().textContent).toContain('Retry copy')
  await act(async () => useAppStore.setState({ workbenchSaveWarning: 'Disk save unavailable' })); await flush(); expect(card().textContent).toContain('kept in this running app')
  let resolve!: () => void; f.copy.mockImplementationOnce(() => new Promise<void>(done => { resolve = done })); await click('[aria-label="Copy answer: Free text answer"]')
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' ? { ...session, control: { ...session.control, hostId: 'new-host', run: { runId: 'new-run' } } } : session) }))); await flush()
  await act(async () => resolve()); expect(card().textContent).not.toContain('Copied'); expect(f.send).not.toHaveBeenCalled()
  await click('.agent-question__footer button'); expect(useAppStore.getState().viewModes[control.agentSessionId]).toBe('terminal')
})
it('same-source native answers never settle old unknown or clear diagnostic; only exact whole-operation notApplied can reject and legacy confirmed stays intact', async () => {
  await setup(true); const frozen = structuredClone(useAppStore.getState().questionReplies[control.agentSessionId]![key])
  for (const answer of ['Original frozen answer', 'Different native answer']) {
    const answered = { ...page, items: [...page.items, { id: 'native-answer', kind: 'user-message' as const, contentParts: [], questionAnswers: [{ questionId: 'first', answer }, { questionId: 'second', answer: 'Native second answer' }] }] }
    await act(async () => root.render(<ActivityView sessionId={control.agentSessionId} capability="complete-events" items={[]} nativeHistoryPage={answered} questionReplyState={target => desktopQuestionReplyState(useAppStore.getState().questionReplies[control.agentSessionId], control.agentSessionId, target)} />)); await flush(); expect(card().textContent).toContain('Answered'); expect(useAppStore.getState().questionReplies[control.agentSessionId]![key]).toEqual(frozen)
  }
  for (const fact of [{ submissionId: 'foreign-operation', run: control.run }, { submissionId: held.input.operationId, run: { runId: 'foreign-run' } }]) { reconcileConversationQuestionReplies(control, fact); await flush(); expect(useAppStore.getState().questionReplies[control.agentSessionId]![key]).toEqual(frozen) }
  reconcileConversationQuestionReplies({ ...control, hostId: 'foreign-host' }, { submissionId: held.input.operationId, run: control.run }); await flush(); expect(useAppStore.getState().questionReplies[control.agentSessionId]![key]).toEqual(frozen)
  await act(async () => reconcileConversationQuestionReplies(control, { submissionId: held.input.operationId, run: control.run })); await flush(); expect(useAppStore.getState().questionReplies[control.agentSessionId]![key]?.phase).toBe('rejected')
  const confirmed = { ...held, phase: 'confirmed' as const }; await act(async () => useAppStore.setState({ questionReplies: { [control.agentSessionId]: { [key]: confirmed } } })); reconcileConversationQuestionReplies(control, { submissionId: held.input.operationId, run: control.run }); await flush(); expect(useAppStore.getState().questionReplies[control.agentSessionId]![key]).toBe(confirmed)
})

it('actual Pane distinguishes retained or unknown native sources and a known old reply Run without blocking draft/copy/original terminal', async () => {
  const f = await setup(); await fill(card().querySelector('[aria-label="Your answer: Free text answer"]')!, 'Kept draft across source changes')
  expect(card().querySelector('.agent-question__footer button')?.textContent).toContain('Answer in original terminal')
  for (const change of [{ nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'changed-native-source' } }, { nativeHandle: undefined }]) {
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' ? { ...session, ...change } : session) }))); await flush()
    expect(card().querySelector('.agent-question__footer button')?.textContent).toContain('View original terminal'); expect(card().textContent).toContain('retained question')
    expect(card().querySelector<HTMLTextAreaElement>('[aria-label="Your answer: Free text answer"]')!.disabled).toBe(false)
    await click('[aria-label="Copy answer: Free text answer"]'); expect(f.copy.mock.lastCall?.[0]).toBe('Kept draft across source changes')
  }
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.kind === 'agent' ? { ...session, nativeHandle: { kind: 'provider', providerId: target.source.providerId, sessionId: target.source.nativeSessionId }, control: { ...control, run: { runId: 'new-run' } } } : session), questionReplies: { [control.agentSessionId]: { [key]: { ...held, phase: 'rejected' } } } }))); await flush()
  expect(card().querySelector('.agent-question__footer button')?.textContent).toContain('View original terminal')
  await click('.agent-question__footer button'); expect(useAppStore.getState().viewModes[control.agentSessionId]).toBe('terminal'); expect(f.send).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled()
})
