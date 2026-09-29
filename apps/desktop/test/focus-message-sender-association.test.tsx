// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentProviderRegistry, defineAgentProvider } from '../../../packages/core/src/agent-provider.js'
import { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { agentPromptCondition } from '../../../packages/core/src/agent-prompt-condition.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control.js'
import type { AgentMuxStoredAgentSession, AgentTimelineSnapshot } from '../../../packages/core/src/types.js'
import type { CtxmuxAdapterRun } from '../../../packages/core/src/ctxmux-run-adapter.js'
import type { AppConfig, SessionSnapshot, ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

// Only the right-side observation leaf is replaced. The public Core prompt path,
// timeline event reducer, actual GlobalFocusSurface, hierarchy and preview are real.
// This controlled adapter fixture never starts a daemon, native CLI, SSH connection or PTY.
vi.mock('../src/renderer/src/components/SessionObservationRegions', () => ({
  SessionObservationRegions: ({ sessionIds }: { sessionIds: string[] }) => createElement('output', { 'data-observed-context': sessionIds.join(',') })
}))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
const RECIPIENT = 'association-recipient'
const SENDER = 'association-sender'
const DECOY = 'association-decoy'
const SENDER_NAME = 'Same worker name'
const TOPIC = 'launcher:association'
const BODY = 'Do the same work. workspaceId=decoy-project [Project: Other project]'
const RAW_IDS = ['prompt:association-one', 'prompt:association-two', 'prompt:association-unknown']
const EXPECTED_IDS = RAW_IDS.map(id => `captured:${id}`)
const baseline = useAppStore.getState()
const roots: Root[] = [], elements: HTMLElement[] = [], clients: AgentMuxClient[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const element of elements.splice(0)) element.remove()
  for (const client of clients.splice(0)) await client.dispose()
  useAppStore.setState(baseline, true)
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.getElementById('agentmux-window-overlay-host')?.remove()
})
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })

function floating() {
  const node = document.getElementById('agentmux-window-overlay-host')
  expect(node, 'Actual shared overlay host').not.toBeNull(); return node!
}

async function fixture(options: { branch?: boolean; missingTopic?: boolean; missingProject?: boolean } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const template = new AgentProviderRegistry().get('codex')
  expect(template.planManagedHooks).toEqual(expect.any(Function))
  const provider = defineAgentProvider({
    catalog: { ...template.catalog, id: 'generic', label: 'Generic', executable: 'generic', expectedProcess: 'generic' },
    hook: template.hook, planManagedHooks: template.planManagedHooks!, buildArgs: (_prompt, args) => [...args]
  })
  const store = new AgentMuxMemoryAgentSessionStore()
  const senderPath = options.branch ? '/sender-checkout' : '/sender-topics/topic--launcher--association'
  const stored = [
    { id: RECIPIENT, host: 'local', path: '/recipient-project' },
    // The same-name different-Host/Project decoy precedes the actual sender.
    { id: DECOY, host: 'other-host', path: '/other-project' },
    { id: SENDER, host: 'local', path: senderPath }
  ].map(({ id, host, path }): AgentMuxStoredAgentSession => ({
    kind: 'agent', agentSessionId: id, providerId: 'generic', executorId: 'generic', hostId: host, workspacePath: path,
    run: { runId: `${id}-original-run` }, retiredRuns: [], hookBindingId: `${id}-binding`, hookToken: `${id}-private-token`,
    createdAt: 1, updatedAt: 1, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 1, stateEnteredAt: 1 }
  }))
  for (const session of stored) await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, providers: [provider] }); clients.push(client)
  const adapter = client as unknown as {
    connected: boolean; registry: { load(host: string): Promise<void> }
    kernel: {
      isConnected(): boolean; identity(): object; status(runId: string): Promise<CtxmuxAdapterRun>
      input(runId: string, operation: { operationId: string; expectedByte: number; data: string }): Promise<{ run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }>
    }
  }
  // One Client has one loaded Host registry. The other-Host decoy is a controlled
  // persisted/Store Context, not a second connected Runtime or native SSH Session.
  await adapter.registry.load('local')
  adapter.connected = true; adapter.kernel.isConnected = () => true
  adapter.kernel.identity = () => ({ daemonInstanceId: 'association-controlled-adapter-no-daemon' })
  const cursors = new Map<string, number>(), writes: Array<{ runId: string; data: string }> = []
  const run = (runId: string): CtxmuxAdapterRun => {
    const session = stored.find(item => item.run.runId === runId)
    expect(session, 'Every adapter request belongs to a real private stored Session').toBeDefined()
    return { runId, lifecycleOperationId: null, program: 'generic', args: [], workspacePath: session!.workspacePath,
      pid: 123, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0,
      acceptedInputBytes: cursors.get(runId) ?? 0 }
  }
  adapter.kernel.status = async runId => run(runId)
  adapter.kernel.input = async (runId, operation) => {
    const startByte = cursors.get(runId) ?? 0
    expect(operation.expectedByte).toBe(startByte)
    writes.push({ runId, data: operation.data }); cursors.set(runId, startByte + Buffer.byteLength(operation.data))
    return { run: run(runId), appliedByteRange: { startByte, endByte: cursors.get(runId)! } }
  }
  const sessions = stored.map((session): Agent => ({
    id: session.agentSessionId, kind: 'agent', providerId: 'generic', executorId: 'generic', hostId: session.hostId,
    workspacePath: session.workspacePath, label: session.agentSessionId === RECIPIENT ? 'Recipient worker' : SENDER_NAME,
    createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: session.hostId, agentSessionId: session.agentSessionId, run: session.run }
  }))
  const senderWorkspaces: WorkspaceRecord[] = options.branch ? [
    { id: 'sender-project', hostId: 'local', name: 'Sender project', path: '/sender-project', kind: 'folder' },
    { id: 'sender-checkout', hostId: 'local', name: 'Sender checkout', path: senderPath, kind: 'worktree', repoPath: '/sender-project', branch: 'feature/current-sender' }
  ] : [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Sender topics', path: '/sender-topics', kind: 'folder' }]
  const config: AppConfig = {
    version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'Private' }, { id: 'other-host', kind: 'ssh', label: 'Controlled other Host', hostname: 'private.invalid' }],
    executors: { generic: { label: 'Generic', providerId: 'generic', command: 'generic', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [
      { id: 'recipient-project', hostId: 'local', name: 'Recipient project', path: '/recipient-project', kind: 'folder' },
      { id: 'decoy-project', hostId: 'other-host', name: 'Other project', path: '/other-project', kind: 'folder' },
      ...(options.missingProject ? [] : senderWorkspaces)
    ],
    appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  }
  let topics: ScratchTopicSnapshot[] = options.missingTopic ? [] : [{
    id: TOPIC, title: 'Current sender topic', directoryPath: senderPath, topicPath: `${senderPath}/topic.md`,
    summary: 'Current work, never historical message ownership', collaborators: []
  }]
  const topicReads = vi.spyOn(api.scratch, 'listTopics').mockImplementation(async () => topics)
  const branchReads = vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => id === 'sender-project'
    ? { kind: 'git-repository', hostId: 'local', repoPath: '/sender-project', branches: [{ name: 'feature/current-sender', worktreePath: senderPath, workspaceId: 'sender-checkout', isCurrent: true }] }
    : { kind: 'not-a-git-repository', hostId: id === 'decoy-project' ? 'other-host' : 'local', workspacePath: id === 'decoy-project' ? '/other-project' : '/recipient-project' })
  const iconReads = vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'directory', icon: null })
  const historyReads = vi.spyOn(api.sessions, 'historyPage')
  const timelineReads = vi.spyOn(api.sessions, 'timeline')
  const unsafe = ['resume', 'recover', 'stop', 'interrupt', 'write', 'paste'] as const
  const lifecycle = unsafe.map(method => vi.spyOn(api.sessions, method))
  useAppStore.setState({ config, sessions, timelines: {}, tabs: {}, layouts: {}, recoveryCandidates: [], agentNames: {
    [RECIPIENT]: 'Recipient worker', [DECOY]: SENDER_NAME, [SENDER]: SENDER_NAME
  }, workspaceFileRevisions: {}, mainSurface: 'agents', activeWorkspaceId: 'recipient-project', error: null,
  agentFocus: { execution: { sessionId: RECIPIENT, history: [] }, pmo: { sessionId: null } } })
  useAppStore.setState({ scratchTopicSnapshots: {} })
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID)
  client.onEvent(event => { if (event.type === 'agent-timeline') useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event }) })
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, prompt, operationId, condition, authorAgentSessionId) => {
    await client.submitAgentPrompt({ agentSessionId: control.agentSessionId, prompt, operationId, ...condition,
      ...(authorAgentSessionId === undefined ? {} : { authorAgentSessionId }), allowUncertainTurn: true })
  })
  // Actual Store Control → public Client admission/input/record → event reducer.
  await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'association-one', operation: 'send',
    target: { kind: 'agent-session', agentSessionId: RECIPIENT }, text: BODY,
    promptCondition: agentPromptCondition(client.agentSession(RECIPIENT)), caller: { agentSessionId: SENDER } })
  expect(submit).toHaveBeenCalledOnce(); expect(submit.mock.calls[0]![4]).toBe(SENDER)
  for (const input of [{ operationId: 'association-two', prompt: BODY, authorAgentSessionId: SENDER }, { operationId: 'association-unknown', prompt: 'Public Core input without a recorded author' }]) {
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(RECIPIENT)), agentSessionId: RECIPIENT, ...input, allowUncertainTurn: true })
  }
  const captured = await client.sessionTimeline(RECIPIENT)
  expect(captured.items.map(item => [item.id, item.agentSessionId, item.kind, item.source, item.content, item.authorAgentSessionId])).toEqual([
    [RAW_IDS[0], RECIPIENT, 'user_message', 'user', BODY, SENDER],
    [RAW_IDS[1], RECIPIENT, 'user_message', 'user', BODY, SENDER],
    [RAW_IDS[2], RECIPIENT, 'user_message', 'user', 'Public Core input without a recorded author', undefined]
  ])
  expect(writes).toEqual([{ runId: `${RECIPIENT}-original-run`, data: BODY + '\r' }, { runId: `${RECIPIENT}-original-run`, data: BODY + '\r' },
    { runId: `${RECIPIENT}-original-run`, data: 'Public Core input without a recorded author\r' }])
  expect(useAppStore.getState().timelines[RECIPIENT]!.items).toEqual(captured.items)
  const element = document.createElement('div'); document.body.append(element); elements.push(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(createElement(GlobalFocusSurface))); await settle()
  expect([...element.querySelectorAll<HTMLElement>('[data-session-id]')].map(node => node.dataset.sessionId).sort()).toEqual([RECIPIENT, DECOY, SENDER].sort())
  return { element, client, captured, writes, sessions, config, topicReads, branchReads, iconReads, historyReads, timelineReads, lifecycle,
    setTopics(next: ScratchTopicSnapshot[]) { topics = next } }
}
type Harness = Awaited<ReturnType<typeof fixture>>
function marker(h: Harness, id = EXPECTED_IDS[0]!) {
  const node = h.element.querySelector<HTMLButtonElement>(`.recent-focus__message[data-message-id="${id}"]`)
  expect(node, `Actual marker ${id}`).toBeTruthy(); return node!
}
function preview(h: Harness, role: 'dialog' | 'tooltip' = 'dialog') {
  const node = floating().querySelector<HTMLElement>(`.recent-focus__message-preview[role="${role}"][aria-label="Message"]`)
  expect(node, `Actual ${role} preview`).toBeTruthy(); return node!
}
async function inspect(h: Harness, id = EXPECTED_IDS[0]!) { await act(async () => marker(h, id).click()); return preview(h) }
function field(node: HTMLElement, label: string) {
  const dt = [...node.querySelectorAll('dt')].find(element => element.textContent === label)
  expect(dt, `Current fact ${label}`).toBeTruthy(); expect(dt!.nextElementSibling?.tagName).toBe('DD')
  return dt!.nextElementSibling!.textContent!
}
function button(node: HTMLElement, label: string) {
  const found = [...node.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === label || element.getAttribute('aria-label') === label)
  expect(found, label).toBeTruthy(); return found!
}
function reads(h: Harness) { return [h.topicReads.mock.calls.length, h.branchReads.mock.calls.length, h.iconReads.mock.calls.length, h.historyReads.mock.calls.length, h.timelineReads.mock.calls.length] }
function senderRunUnknown(node: HTMLElement) {
  expect(node.querySelector('.recent-focus__sender-run')?.textContent).toBe('Sender Run not recorded · Execution relationship unknown')
}

it('keeps two identical public captured Agent inputs and an unknown input on the exact recipient track', async () => {
  const h = await fixture()
  const markers = [...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
  expect(markers.map(node => node.dataset.messageId)).toEqual(EXPECTED_IDS)
  expect(markers.map(node => node.closest<HTMLElement>('[data-focus-timeline-id]')!.dataset.focusTimelineId)).toEqual([RECIPIENT, RECIPIENT, RECIPIENT])
  expect(markers.map(node => node.dataset.messageAuthor)).toEqual(['agent', 'agent', 'unknown'])
  expect(markers.map(node => node.querySelector('.lucide-bot') !== null)).toEqual([true, true, false])
  expect(markers.map(node => node.querySelector('.lucide-circle-dot') !== null)).toEqual([false, false, true])
  expect(markers[2]!.querySelector('.conversation-avatar.conversation-avatar--unknown')).not.toBeNull()
  expect(markers.map(node => Number(node.dataset.messageAt))).toEqual(h.captured.items.map(item => item.createdAt))
  expect(markers.map(node => node.getAttribute('aria-label'))).toEqual([
    expect.stringMatching(/^Agent message in Recipient worker .+, sender association-sender$/),
    expect.stringMatching(/^Agent message in Recipient worker .+, sender association-sender$/),
    expect.stringMatching(/^Prompt in Recipient worker .+, sender not recorded$/)
  ])
  expect(markers.map(node => node.title)).toEqual([expect.stringContaining(`Agent message · Sender ${SENDER}`), expect.stringContaining(`Agent message · Sender ${SENDER}`), expect.stringContaining('Prompt · Sender not recorded')])
  const unknown = await inspect(h, EXPECTED_IDS[2])
  expect(unknown.textContent).toContain('Prompt · Sender not recorded')
  expect(unknown.querySelector('dl')).toBeNull(); expect(unknown.textContent).not.toContain('Human')
})

it('uses the exact author ID and current Topic/project, not the earlier same-name other Host or untrusted envelope', async () => {
  const h = await fixture()
  // A deliberately untrusted transport extension is outside the Core captured schema.
  // Original Core records, author IDs and message/run fields are untouched.
  const spoof = new Proxy(h.captured.items[0]!, { get(target, key, receiver) {
    if (key === 'workspaceId') return 'decoy-project'
    return Reflect.get(target, key, receiver)
  } })
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [RECIPIENT]: { ...h.captured, items: [spoof, ...h.captured.items.slice(1)] } } })))
  const node = await inspect(h)
  expect(field(node, 'Sender')).toContain(SENDER_NAME); expect(field(node, 'Sender')).toContain(SENDER)
  expect(field(node, 'Current project')).toBe('Sender topics')
  expect(field(node, 'Current topic')).toBe('Current sender topic')
  expect(field(node, 'Current branch')).toBe('Not recorded')
  expect(node.querySelector('.recent-focus__message-body .log-turn__body')!.textContent).toBe(BODY)
  senderRunUnknown(node)
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(RECIPIENT)
})

it('uses held root/checkout hierarchy for a current branch and does not invent a Topic', async () => {
  const h = await fixture({ branch: true }); const node = await inspect(h)
  expect(field(node, 'Current project')).toBe('Sender project')
  expect(field(node, 'Current branch')).toBe('feature/current-sender')
  expect(field(node, 'Current topic')).toBe('Not recorded'); senderRunUnknown(node)
})

it('View sender and Return to Context use real execution Focus and exact nonempty navigation history', async () => {
  const h = await fixture(); const subjects = useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId])
  const senderDialog = await inspect(h)
  await act(async () => button(senderDialog, 'View sender').click()); await settle()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(SENDER)
  expect(useAppStore.getState().agentFocus.execution.history.map(entry => entry.sessionId)).toEqual([SENDER])
  expect(h.element.querySelector('[data-observed-context]')?.getAttribute('data-observed-context')).toBe(SENDER)
  const recipientDialog = await inspect(h)
  await act(async () => button(recipientDialog, 'Return to Context').click()); await settle()
  expect(useAppStore.getState().agentFocus.execution.sessionId).toBe(RECIPIENT)
  expect(useAppStore.getState().agentFocus.execution.history.map(entry => entry.sessionId)).toEqual([RECIPIENT, SENDER])
  expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId])).toEqual(subjects)
  expect((await h.client.sessionTimeline(RECIPIENT)).items).toEqual(h.captured.items)
  expect(h.writes).toHaveLength(3)
  expect(h.lifecycle.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('mouse hover, keyboard focus and preview open/close observe without changing execution/history or input', async () => {
  const h = await fixture()
  // Observation must also stay passive when this marker belongs to a different
  // Context: re-selecting the initial recipient would otherwise be a no-op.
  await act(async () => useAppStore.getState().focusExecutionSession(SENDER)); await settle()
  const origin = useAppStore.getState().agentFocus
  expect(origin.execution.sessionId).toBe(SENDER)
  expect(origin.execution.history.map(entry => entry.sessionId)).toEqual([SENDER])
  const search = h.element.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!; search.focus()
  // A real managed-to-managed crossing includes both events. React's enter/leave
  // plugin intentionally ignores an isolated over with a managed relatedTarget.
  const target = marker(h)
  await act(async () => {
    search.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: target }))
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: search }))
  })
  expect(field(preview(h, 'tooltip'), 'Current topic')).toBe('Current sender topic')
  expect(document.activeElement).toBe(search); expect(useAppStore.getState().agentFocus).toBe(origin)
  await act(async () => marker(h).dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: search })))
  expect(floating().querySelector('[role="tooltip"]')).toBeNull()
  await act(async () => marker(h).focus())
  expect(field(preview(h, 'tooltip'), 'Sender')).toContain(SENDER)
  expect(useAppStore.getState().agentFocus).toBe(origin)
  await act(async () => marker(h).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(floating().querySelector('[role="tooltip"]')).toBeNull()
  const node = await inspect(h)
  await act(async () => button(node, 'Close message').click())
  expect(floating().querySelector('[role="dialog"]')).toBeNull(); expect(useAppStore.getState().agentFocus).toBe(origin)
  expect(h.writes).toHaveLength(3); expect(h.lifecycle.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
})

it('pinned Escape restores its real marker without reopening a tooltip, and an explicit next click works', async () => {
  const h = await fixture(), origin = useAppStore.getState().agentFocus, target = marker(h)
  await act(async () => target.focus())
  expect(preview(h, 'tooltip')).toBeTruthy(); expect(document.activeElement).toBe(target)
  const node = await inspect(h)
  expect(document.activeElement).toBe(node)
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  expect(document.activeElement).toBe(target)
  expect(floating().querySelectorAll('.recent-focus__message-preview')).toHaveLength(0)
  expect(useAppStore.getState().agentFocus).toBe(origin)
  await act(async () => target.click())
  expect(preview(h)).toBeTruthy(); expect(useAppStore.getState().agentFocus).toBe(origin)
})

it.each(['removed', 'pmo'] as const)('a %s sender Context retains original author/body and cannot navigate to the same-name decoy', async kind => {
  const h = await fixture(); await inspect(h)
  await act(async () => useAppStore.setState(state => ({ sessions: kind === 'removed' ? state.sessions.filter(session => session.id !== SENDER)
    : state.sessions.map(session => session.id === SENDER ? { ...session, workspacePath: '/sender-topics/topic--launcher--leader' } : session) })))
  const node = preview(h)
  expect(node.textContent).toContain(SENDER); expect(node.querySelector('.recent-focus__message-body .log-turn__body')!.textContent).toBe(BODY)
  expect(button(node, 'View sender').disabled).toBe(true)
  const origin = useAppStore.getState().agentFocus
  await act(async () => button(node, 'View sender').click())
  expect(useAppStore.getState().agentFocus).toBe(origin); senderRunUnknown(node)
  expect(field(node, 'Current project')).toBe('Not recorded')
  expect(field(node, 'Current branch')).toBe('Not recorded'); expect(field(node, 'Current topic')).toBe('Not recorded')
  if (kind === 'pmo') expect(PMO_TEAMS_TOPIC_ID).toBe('launcher:leader')
})

it('a missing recipient retains the pinned original record and disables Return instead of picking another Context', async () => {
  const h = await fixture(); await inspect(h)
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.filter(session => session.id !== RECIPIENT) })))
  const node = preview(h), origin = useAppStore.getState().agentFocus
  expect(node.querySelector('.recent-focus__message-body .log-turn__body')!.textContent).toBe(BODY)
  expect(button(node, 'Return to Context').disabled).toBe(true)
  await act(async () => button(node, 'Return to Context').click())
  expect(useAppStore.getState().agentFocus).toBe(origin)
  expect(button(node, 'View sender').disabled).toBe(false)
})

it.each(['project', 'topic'] as const)('a missing sender %s remains explicitly unknown independently of the captured author', async missing => {
  const h = await fixture({ missingProject: missing === 'project', missingTopic: missing === 'topic' })
  const node = await inspect(h)
  expect(field(node, 'Sender')).toContain(SENDER)
  expect(field(node, 'Current project')).toBe(missing === 'project' ? 'Not recorded' : 'Sender topics')
  expect(field(node, 'Current topic')).toBe('Not recorded')
  expect(node.querySelector('.recent-focus__message-body .log-turn__body')!.textContent).toBe(BODY); senderRunUnknown(node)
})

it('sender old-to-current Run replacement and unknown working start never become this message execution', async () => {
  const h = await fixture(); await inspect(h)
  expect(h.captured.items.map(item => item.authorAgentSessionId)).toEqual([SENDER, SENDER, undefined])
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === SENDER && session.kind === 'agent'
    ? { ...session, control: { ...session.control, run: { runId: 'sender-current-replacement-run' } },
        status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
        semanticStatus: { state: 'working', source: 'native-hook', observedAt: Date.now() } }
    : session) })))
  const node = preview(h); senderRunUnknown(node)
  expect(node.querySelector('.recent-focus__sender-work')!.textContent).toContain('Current: Working')
  expect(node.textContent).not.toContain('sender-current-replacement-run')
  expect(node.textContent).not.toContain(`${RECIPIENT}-original-run`)
  const live = h.element.querySelector<HTMLButtonElement>(`[data-focus-timeline-id="${SENDER}"] .recent-focus__live`)!
  expect(live.dataset.runId).toBe('sender-current-replacement-run'); expect(live.title).toContain('Work start unknown')
  expect(h.element.querySelector(`[data-focus-timeline-id="${SENDER}"] .recent-focus__working`)).toBeNull()
  expect((await h.client.sessionTimeline(RECIPIENT)).items).toEqual(h.captured.items)
})

it('unchanged messages and unrelated bytes/observedAt incur no new sender, Topic, icon or source reads', async () => {
  const h = await fixture()
  expect(h.topicReads.mock.calls.map(call => call[0])).toEqual([SCRATCH_WORKSPACE_ID])
  const initialReads = reads(h)
  expect(initialReads[0]).toBe(1); expect(initialReads[1]).toBe(2)
  let itemReads = 0
  const measured: AgentTimelineSnapshot = new Proxy(useAppStore.getState().timelines[RECIPIENT]!, { get(target, key, receiver) {
    if (key === 'items') itemReads++
    return Reflect.get(target, key, receiver)
  } })
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [RECIPIENT]: measured } })))
  expect([...h.element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')].map(node => node.dataset.messageId)).toEqual(EXPECTED_IDS)
  expect(itemReads).toBeGreaterThan(0)
  const updateUnrelated = async () => {
    for (let i = 1; i <= 10; i++) await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === DECOY
      ? { ...session, latestOutputBytes: i, status: { ...session.status, observedAt: i } } : session) })))
  }
  itemReads = 0; await updateUnrelated(); expect(itemReads).toBe(0); expect(reads(h)).toEqual(initialReads)
  await inspect(h); expect(reads(h)).toEqual(initialReads)
  itemReads = 0; await updateUnrelated(); expect(itemReads).toBe(0); expect(reads(h)).toEqual(initialReads)
  await act(async () => button(preview(h), 'Close message').click())
  itemReads = 0; await updateUnrelated(); expect(itemReads).toBe(0); expect(reads(h)).toEqual(initialReads)
  expect(h.writes).toHaveLength(3)
})

it('late current Topic facts and source changes cannot rewrite a pinned original message author', async () => {
  const h = await fixture(); await inspect(h)
  h.setTopics([{ id: TOPIC, title: 'Updated current topic', directoryPath: '/sender-topics/topic--launcher--association',
    topicPath: '', summary: '', collaborators: [] }])
  await act(async () => useAppStore.setState(state => ({ workspaceFileRevisions: { ...state.workspaceFileRevisions, [SCRATCH_WORKSPACE_ID]: 1 } })))
  await settle()
  expect(field(preview(h), 'Current topic')).toBe('Updated current topic')
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, [RECIPIENT]: { ...h.captured,
    revision: h.captured.revision + 1, items: h.captured.items.map((item, index) => index === 0 ? { ...item, authorAgentSessionId: DECOY } : item) } } })))
  const node = preview(h)
  expect(field(node, 'Sender')).toContain(SENDER)
  expect(field(node, 'Current project')).toBe('Sender topics')
  expect(node.querySelector('.recent-focus__message-body .log-turn__body')!.textContent).toBe(BODY)
  expect((await h.client.sessionTimeline(RECIPIENT)).items).toEqual(h.captured.items)
})
