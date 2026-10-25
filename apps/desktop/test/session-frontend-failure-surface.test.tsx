// @vitest-environment happy-dom
import { fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import type { AgentMuxAgentSession, AgentTerminalFrontend } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { conversationPagePortFixture } from './helpers/conversation-page-port-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
// Runtime bytes are a controlled leaf. Workbench, SessionPane, Core-event projection,
// original recovery action, lifecycle feedback and the rich Composer are production code.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session, readOnly, visible }: {
  session: ReturnType<typeof composerSession>; readOnly: boolean; visible: boolean
}) => <div data-original-terminal data-run={session.control.run.runId} data-read-only={String(readOnly)} data-visible={String(visible)}>
  Raw CLI stack trace. Keep original bytes.
</div> }))

const dom = composerDOM()
const sessionId = 'original-frontend-session', draft = 'Original unsent input 中'
const failedFrontend = (run: AgentTerminalFrontend['run']): AgentTerminalFrontend => ({
  run, frontendId: 'original-frontend', state: 'detached', backendState: 'running',
  source: 'managed-process', observedAt: _tailFixtureEpoch(0, 0, 100), exitCode: 1
})
const region = () => dom.container.querySelector<HTMLElement>('[data-workbench-region-id="original-region"]')!
const surface = () => region().querySelector<HTMLElement>('.full-page-loading--failed')
const terminal = () => region().querySelector<HTMLElement>('[data-original-terminal]')
const input = () => region().querySelector<HTMLElement>('[role="textbox"]')! as HTMLElement & { editor: Editor }
const button = (label: string) => [...region().querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
async function until(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 3000 }) }
async function click(label: string) { expect(button(label), label).toBeDefined(); await act(async () => button(label).click()) }
function seed(frontend: AgentTerminalFrontend | undefined, providerId = 'codex') {
  const session = { ...composerSession(sessionId, providerId), ...(frontend ? { terminalFrontend: frontend } : {}) }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId })
  const layout = { root: { type: 'leaf' as const, groupId: 'original-group' }, groups: [{ id: 'original-group',
    tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: 'original-group' }
  useAppStore.setState({ loading: false, config: { ...composerConfig, executors: { ...composerConfig.executors,
      [providerId]: { ...composerConfig.executors.codex!, providerId, label: providerId } } },
    sessions: [session], tabs: { [tab.id]: tab }, layouts: { workspace: layout }, mainSurface: 'workbench',
    activeWorkspaceId: 'workspace', viewModes: { [sessionId]: 'terminal' }, agentNames: {},
    pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [], timelines: {},
    agentComposerDrafts: { [sessionId]: draft }, agentSteerQueues: {}, agentSteerInFlight: {}, notificationEvents: [], noticeReadReceipts: {} })
  return { session, tab, layout }
}
function event(original: ReturnType<typeof composerSession>, frontend: AgentTerminalFrontend, updatedAt: number) {
  const session: AgentMuxAgentSession = { kind: 'agent', agentSessionId: original.id, providerId: original.providerId,
    executorId: original.executorId, hostId: original.control.hostId, workspacePath: original.workspacePath,
    run: original.control.run, retiredRuns: [], createdAt: original.createdAt, updatedAt, terminalFrontend: frontend,
    ...(original.nativeHandle ? { nativeHandle: original.nativeHandle } : {}) }
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session } })
}
function protectedState(original: ReturnType<typeof seed>) {
  const state = useAppStore.getState(), current = state.sessions[0]!
  expect(current.id).toBe(sessionId); expect(current.control).toEqual(original.session.control)
  expect(current.processState).toBe('running'); expect(state.tabs[original.tab.id]).toEqual(original.tab)
  expect(state.layouts.workspace).toEqual(original.layout); expect(state.agentComposerDrafts[sessionId]).toBe(draft)
  expect(input().getAttribute('contenteditable')).toBe('true')
  expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(api.sessions.stop).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api.connections, 'call').mockImplementation(async method => {
    if (method === 'connection.binding.ls') return { bindings: [] } as never
    throw new Error('Unexpected connection operation: ' + method)
  })
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: composerConfig.workspaces[0]!.path })
  vi.spyOn(api.sessions, 'launchAgent'); vi.spyOn(api.sessions, 'submitPrompt'); vi.spyOn(api.sessions, 'stop')
})
afterEach(async () => { await act(async () => getSelection()?.removeAllRanges()) })

it.each(['codex', 'claude'])('the actual Workbench gives an exact failed %s frontend a complete surface while its running backend and unconfirmed native identity remain honest', async provider => {
  const original = seed(failedFrontend(composerSession(sessionId).control.run), provider)
  expect(original.session.nativeHandle).toBeUndefined()
  const recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  await until(() => expect(surface()).not.toBeNull())
  expect(surface()?.querySelector('h2')?.textContent).toBe('Terminal process exited')
  const summary = surface()!.querySelector('.surface-state__description')!
  const actions = surface()!.querySelector('.surface-state__actions')!
  expect(summary.textContent).toContain('exited with code 1')
  expect(summary.textContent).toContain('The backend is still running.')
  expect(summary.textContent).toContain('native conversation identity is not yet confirmed')
  expect(summary.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(actions.querySelector('.primary-button')?.textContent).toContain('Resume')
  expect(actions.querySelector('.small-button')?.textContent).toContain('Read original output')
  expect(surface()?.textContent).toContain('exited with code 1')
  expect(surface()?.textContent).toContain('The backend is still running.')
  expect(surface()?.textContent).toContain('native conversation identity is not yet confirmed')
  expect(surface()?.textContent).toContain('The cause is unknown; read the original output')
  expect(surface()?.textContent).toContain('Check the CLI startup environment, then choose Resume or restart AgentMux.')
  expect(surface()?.textContent).not.toContain('same conversation')
  expect(surface()?.textContent).not.toContain('Raw CLI stack trace')
  expect(terminal()).toBeNull(); expect(button('Resume').disabled).toBe(false)
  const editor = input(), rich = editor.editor
  await act(async () => { editor.focus(); rich.commands.setTextSelection({ from: 3, to: 8 }); editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })) })
  const selected = rich.state.selection.toJSON()
  await click('Read original output')
  const raw = terminal()!
  expect(raw?.textContent).toContain('Raw CLI stack trace'); expect(raw?.dataset.run).toBe(original.session.control.run.runId)
  const outputActions = region().querySelector('.session-frontend-exit__actions')!
  expect(outputActions.querySelector('.primary-button')?.textContent).toContain('Resume')
  expect(outputActions.querySelector('.small-button')?.textContent).toContain('Back to recovery')
  expect(raw?.dataset.readOnly).toBe('true'); expect(raw?.dataset.visible).toBe('true')
  expect(surface()).toBeNull()
  await click('Back to recovery')
  expect(surface()).not.toBeNull(); expect(terminal()).toBe(raw)
  expect(raw.closest('[hidden]')).not.toBeNull(); expect(raw.dataset.visible).toBe('false')
  expect(input()).toBe(editor); expect(rich.state.selection.toJSON()).toEqual(selected)
  expect(document.activeElement).toBe(editor); expect(rich.view.composing).toBe(true)
  expect(recover).not.toHaveBeenCalled(); protectedState(original)
  await act(async () => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })))
})

it.each([
  ['codex', 'Error: request to account route timed out\nCaused by: connection deadline exceeded'],
  ['claude', "Configuration could not be loaded:\nPermission denied while reading " + _tailFixturePath("private/example/config")]
])('shows the original %s terminal diagnostic and startup remedy on the first failure surface', async (provider, diagnostic) => {
  const original = seed({ ...failedFrontend(composerSession(sessionId).control.run), message: diagnostic }, provider)
  const recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  await until(() => expect(surface()).not.toBeNull())
  const cause = surface()!.querySelector('.session-frontend-diagnostic pre')!
  expect(cause.textContent).toBe(diagnostic)
  expect(cause.closest('details')).toBeNull()
  expect(cause.closest('[hidden]')).toBeNull()
  expect(surface()!.querySelectorAll('.session-frontend-diagnostic')).toHaveLength(1)
  expect(surface()?.textContent).toContain('The backend is still running.')
  expect(surface()?.textContent).toContain('Check the CLI startup environment, then choose Resume or restart AgentMux.')
  expect(button('Resume').disabled).toBe(false)
  expect(button('Read original output').disabled).toBe(false)
  expect(recover).not.toHaveBeenCalled(); protectedState(original)
})

it('shows the original unknown startup diagnostic by default without treating the running backend as ready or failed', async () => {
  const diagnostic = 'Original native request rejected while another writer owns this conversation.'
  const original = seed({ ...failedFrontend(composerSession(sessionId).control.run), state: 'starting', exitCode: undefined,
    initialization: { lifecycleOperationId: 'original-initialization', phase: 'unknown', native: { state: 'unknown' },
      failure: { step: 'native-session', code: -32600, message: diagnostic } } })
  const recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  await until(() => expect(region().querySelector('.full-page-loading h2')?.textContent).toBe('Startup result unconfirmed'))
  const startup = region().querySelector('.full-page-loading')!, cause = startup.querySelector('.session-frontend-diagnostic pre')!
  expect(cause.textContent).toBe(diagnostic); expect(cause.closest('details')).toBeNull()
  expect(cause.closest('[hidden]')).toBeNull(); expect(startup.querySelectorAll('.session-frontend-diagnostic')).toHaveLength(1)
  expect(startup.getAttribute('data-loading-phase')).toBe('parked')
  expect(startup.querySelector('details')?.open).toBe(false)
  expect(button('Check startup').disabled).toBe(false); expect(button('Read original output').disabled).toBe(false)
  expect(terminal()).toBeNull(); expect(recover).not.toHaveBeenCalled(); protectedState(original)
})

it('keeps the mounted original terminal reader through a live frontend failure, explicit output reading and a recovered exact frontend', async () => {
  const original = seed(undefined)
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  await until(() => expect(terminal()).not.toBeNull())
  const raw = terminal()!, text = raw.firstChild!, range = document.createRange()
  range.setStart(text, 0); range.setEnd(text, 8); await act(async () => getSelection()!.addRange(range))
  await act(async () => event(original.session, failedFrontend(original.session.control.run), _tailFixtureEpoch(0, 0, 101)))
  await until(() => expect(surface()).not.toBeNull())
  expect(terminal()).toBe(raw); expect(raw.closest('[hidden]')).not.toBeNull()
  expect(text.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range)
  await click('Read original output'); expect(terminal()).toBe(raw); expect(raw.dataset.readOnly).toBe('true')
  await click('Back to recovery'); expect(terminal()).toBe(raw); expect(surface()).not.toBeNull()
  await act(async () => event(original.session, { ...failedFrontend(original.session.control.run), frontendId: 'recovered-frontend', state: 'attached', observedAt: _tailFixtureEpoch(0, 0, 200) }, _tailFixtureEpoch(0, 0, 201)))
  await until(() => expect(surface()).toBeNull())
  expect(terminal()).toBe(raw); expect(raw.closest('[hidden]')).toBeNull()
  expect(raw.dataset.visible).toBe('true'); expect(raw.dataset.readOnly).toBe('false')
  expect(text.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range)
  protectedState(original)
})

it('keeps accepted Activity body, reader and Range available when only its terminal frontend fails', async () => {
  const original = seed(undefined), source = { providerId: 'codex', nativeSessionId: 'original-native-thread' }
  original.session = { ...original.session, nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId } }
  useAppStore.setState({ sessions: [original.session], viewModes: { [sessionId]: 'activity' } })
  const reading = await conversationPagePortFixture(original.session.control, source, async id => ({
    agentSessionId: id, source, items: [{ id: 'original-answer', kind: 'assistant-message',
      contentParts: [{ kind: 'text', text: 'Original answer with **selected words** remains readable.' }] }], nextCursor: null
  }))
  try {
    await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
    await until(() => expect(region().querySelector('.log-turn__body strong')).not.toBeNull())
    const feed = region().querySelector('.activity-feed')!, selected = feed.querySelector('.log-turn__body strong')!, text = selected.firstChild!
    const range = document.createRange(); range.selectNodeContents(selected); await act(async () => getSelection()!.addRange(range))
    const reads = reading.nativeRead.mock.calls.length
    await act(async () => event(original.session, failedFrontend(original.session.control.run), _tailFixtureEpoch(0, 0, 101)))
    await until(() => expect(feed.querySelector('.activity-feed__read-notice')?.textContent).toContain('Terminal process exited'))
    expect(region().querySelector('.activity-feed')).toBe(feed); expect(feed.closest('[hidden]')).toBeNull()
    expect(feed.querySelector('.log-turn__body strong')).toBe(selected); expect(selected.firstChild).toBe(text)
    expect(text.isConnected).toBe(true); expect(getSelection()!.getRangeAt(0)).toBe(range)
    expect(getSelection()!.toString()).toBe('selected words')
    expect(feed.querySelector('.activity-feed__read-notice')?.textContent).toContain('The backend is still running.')
    expect([...region().querySelectorAll('.full-page-loading--failed')].filter(node => !node.closest('[hidden]'))).toHaveLength(0)
    expect(terminal()).toBeNull()
    expect(reading.nativeRead).toHaveBeenCalledTimes(reads)
    expect(reading.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    protectedState(original)
  } finally { await dom.render(null); await reading.close() }
})

it('Resume consumes and retains the original Core unknown recovery result without claiming a native conversation or replaying the initial input', async () => {
  const original = seed(failedFrontend(composerSession(sessionId).control.run)), message = 'The exact original native thread is not confirmed. The backend and retained Session remain available.'
  const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async (_control, _workspacePath, operationId) => ({
    kind: 'pending', agentSessionId: sessionId, previousRun: original.session.control.run, reason: 'operation-unconfirmed',
    evidence: { kind: 'run-running', observedAt: _tailFixtureEpoch(0, 0, 200) }, continuity: {
      operationId: operationId!, agentSessionId: sessionId, trigger: 'manual', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
      previousRun: original.session.control.run, admittedAt: _tailFixtureEpoch(0, 0, 200), observedAt: _tailFixtureEpoch(0, 0, 201), rechecks: 0,
      kind: 'pending', reason: 'operation-unconfirmed', errorCode: 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED', error: message,
      evidence: { kind: 'run-running', observedAt: _tailFixtureEpoch(0, 0, 200) }
    }
  }))
  const refresh = vi.spyOn(api.sessions, 'refresh')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  await until(() => expect(surface()).not.toBeNull())
  await click('Resume')
  await until(() => expect(surface()?.textContent).toContain(message))
  const operation = recover.mock.calls[0]![2]
  expect(operation).toEqual(expect.any(String))
  expect(recover.mock.calls[0]).toEqual([original.session.control, original.session.workspacePath, operation, { trigger: 'manual' }])
  expect(surface()?.textContent).toContain('pending · operation-unconfirmed')
  expect(surface()?.textContent).toContain('Native conversationUnknown')
  await click('Resume')
  expect(recover).toHaveBeenCalledTimes(2); expect(recover.mock.calls[1]![2]).toBe(operation)
  expect(surface()?.textContent).toContain(message); expect(refresh).not.toHaveBeenCalled()
  expect(terminal()).toBeNull(); protectedState(original)
})

it.each(['normal-exit', 'unknown', 'wrong-run', 'attached'] as const)('keeps %s on its original terminal path without converting observation into a failed Run', async kind => {
  const base = failedFrontend(composerSession(sessionId).control.run)
  const frontend = kind === 'normal-exit' ? { ...base, exitCode: 0 }
    : kind === 'unknown' ? { ...base, state: 'unknown' as const, backendState: 'unknown' as const }
      : kind === 'wrong-run' ? { ...base, run: { runId: 'unrelated-old-run' } }
        : { ...base, state: 'attached' as const }
  const original = seed(frontend), recover = vi.spyOn(api.sessions, 'recover')
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  await until(() => expect(terminal()).not.toBeNull())
  expect(surface()).toBeNull(); expect(region().querySelector('.session-frontend-diagnostic')).toBeNull()
  expect(terminal()?.dataset.readOnly).toBe('false')
  expect(terminal()?.dataset.visible).toBe('true'); expect(button('Read original output')).toBeUndefined()
  if (kind === 'normal-exit') expect(region().querySelector('.terminal-recovery')?.textContent).toContain('Terminal disconnected')
  else expect(region().querySelector('.terminal-recovery')).toBeNull()
  expect(recover).not.toHaveBeenCalled(); protectedState(original)
})
