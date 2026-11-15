// @vitest-environment happy-dom
import { createRequire } from 'node:module'
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { conversationRevision } from '@agentmux/core/conversation'
import { applyAgentTimelineMutation } from '@agentmux/core/timeline'
import { questionReplyKey } from '@agentmux/client-ui/conversation-question-reply'
import { expect, it, vi } from 'vitest'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import type { DesktopQuestionReplyAttempt } from '../src/renderer/src/lib/conversation-question-intent'
import { api } from '../src/renderer/src/lib/api'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { useAppStore } from '../src/renderer/src/store'
import type { SessionSnapshot } from '../src/shared/contracts'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { questionRefusalEvent } from './helpers/question-refusal-fixture'
import { installNativePopover } from './fixtures/mote-workface'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// Only replace the platform terminal. Pane, mailbox and rich editor use the production components.
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session }: { session: SessionSnapshot }) => <div data-run={session.control.run.runId} data-active-at={session.updatedAt} />
}))

const dom = composerDOM({ agentInformation: true }), session = composerSession(), origin = { workspaceId: 'workspace' }
const other = composerSession('other-agent')
const show = (visible: boolean, revision = 0) => dom.render(<div data-parent-revision={revision}>
  <SessionPane sessionId={session.id} surfaceKind="agent" visible={visible} linkOrigin={origin} interactiveResize={false} />
</div>)

function observe(target: typeof session, observedAt: number, state: 'working' | 'done' = 'working') {
  useAppStore.getState().applyEvent({ type: 'core', hostId: target.hostId, event: {
    type: 'agent-status', agentSessionId: target.id, state,
    evidence: { source: 'native-hook', observedAt, run: target.control.run }
  } })
}

function capture(sequence: number, observedAt: number) {
  const item = {
    id: `capture-${sequence}`, agentSessionId: session.id,
    kind: sequence === 1 ? 'user_message' as const : 'assistant_message' as const,
    source: 'native-hook' as const, status: 'complete' as const, title: 'Captured input',
    content: sequence === 1 ? 'Plan weekend trip' : 'A recorded reply', createdAt: sequence + 1, updatedAt: sequence + 1
  }
  const mutation = { type: 'append' as const, agentSessionId: session.id, item }
  const [normalized] = applyAgentTimelineMutation([], mutation)
  useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: {
    type: 'agent-timeline', agentSessionId: session.id, sourceHostId: session.hostId, revision: sequence, mutation,
    stream: { epoch: 'presentation-source', origin: 'beginning', sequence, revision: sequence, gaps: [] },
    position: { id: item.id, firstSequence: sequence, sequence, revision: conversationRevision(normalized) },
    evidence: { source: 'native-hook', observedAt, run: session.control.run }
  } })
}

it.each(['unchanged', 'advancing'] as const)('the mounted hidden pane and composer skip captured presentation on an %s activity clock', async clock => {
  useAppStore.setState({ timelines: {}, viewModes: { [session.id]: 'terminal' } })
  await show(true)
  const element = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
  const terminal = dom.container.querySelector<HTMLElement>('[data-run]')!
  expect(element.editor).toBeDefined()
  await act(async () => { element.editor.commands.setTextSelection({ from: 3, to: 6 }) })
  await show(false)
  const before = rendererPerformance.snapshot().consumers
  for (let sequence = 1; sequence <= 10; sequence++) {
    await act(async () => capture(sequence, clock === 'advancing' ? sequence + 1 : session.updatedAt))
  }
  const after = rendererPerformance.snapshot().consumers
  expect(useAppStore.getState().timelines[session.id]?.items).toHaveLength(10)
  const observedAt = clock === 'advancing' ? 11 : session.updatedAt
  expect(useAppStore.getState().sessions[0]?.updatedAt).toBe(observedAt)
  const counts = {
    paneChecks: after.sessionPane.hidden.checks - before.sessionPane.hidden.checks,
    paneCommits: after.sessionPane.hidden.commits - before.sessionPane.hidden.commits,
    composerChecks: after.composer.hidden.checks - before.composer.hidden.checks,
    composerCommits: after.composer.hidden.commits - before.composer.hidden.commits
  }
  console.log(JSON.stringify({ clock, events: 10, ...counts }))
  expect(counts).toEqual({ paneChecks: 0, paneCommits: 0, composerChecks: 0, composerCommits: 0 })
  await show(true)
  expect(dom.container.querySelector('.tiptap')).toBe(element)
  expect(dom.container.querySelector('[data-run]')).toBe(terminal)
  expect(terminal.dataset).toMatchObject({ run: session.control.run.runId, activeAt: String(observedAt) })
  expect(element.editor.state.selection).toMatchObject({ from: 3, to: 6 })
  expect(element.textContent).toBe('Keep my draft')
  expect(dom.container.textContent).toContain('Plan weekend trip')
  await act(async () => capture(11, 12))
  expect(terminal.dataset.activeAt).toBe('12')
})

it.each(['original status clock', 'another Session status clock', 'parent refresh'] as const)('keeps the mounted Composer stable through %s updates', async source => {
  const started = Date.now()
  useAppStore.setState({ sessions: [session, other], viewModes: { [session.id]: 'terminal' }, timelines: {} })
  observe(session, started)
  observe(other, started)
  await show(true)
  const editor = dom.container.querySelector<HTMLElement & { editor: Editor }>('.tiptap')!
  const terminal = dom.container.querySelector<HTMLElement>('[data-run]')!
  await act(async () => { editor.editor.commands.setTextSelection({ from: 3, to: 6 }) })
  const transactions = vi.fn()
  editor.editor.on('transaction', transactions)
  const update = async (visible: boolean, sequence: number) => {
    if (source === 'parent refresh') await show(visible, sequence)
    else await act(async () => observe(source === 'original status clock' ? session : other, started + sequence))
  }
  const assertWorkface = () => {
    expect(dom.container.querySelector('.tiptap')).toBe(editor)
    expect(dom.container.querySelector('[data-run]')).toBe(terminal)
    expect(terminal.dataset.run).toBe(session.control.run.runId)
    expect(editor.editor.state.selection).toMatchObject({ from: 3, to: 6 })
    expect(editor.textContent).toBe('Keep my draft')
  }
  const beforeVisible = rendererPerformance.snapshot().consumers.composer.visible.commits
  for (let sequence = 1; sequence <= 10; sequence++) await update(true, sequence)
  const visibleCommits = rendererPerformance.snapshot().consumers.composer.visible.commits - beforeVisible
  expect(transactions).not.toHaveBeenCalled()
  assertWorkface()

  await show(false)
  const before = rendererPerformance.snapshot().consumers.composer.hidden.commits
  for (let sequence = 11; sequence <= 20; sequence++) await update(false, sequence)
  const commits = rendererPerformance.snapshot().consumers.composer.hidden.commits - before
  expect(useAppStore.getState().sessions.map(item => item.status.observedAt)).toEqual([
    started + (source === 'original status clock' ? 20 : 0), started + (source === 'another Session status clock' ? 20 : 0)
  ])
  if (source === 'parent refresh') expect(dom.container.querySelector('[data-parent-revision]')?.getAttribute('data-parent-revision')).toBe('20')
  expect({ hidden: commits, visible: visibleCommits }).toEqual({ hidden: 0, visible: 0 })
  await show(true)
  assertWorkface()
})

it('updates the open Agent status details without committing the Composer', async () => {
  const now = Math.floor(Date.now() / 1000) * 1000
  observe(session, now - 1000)
  await show(true)
  const editor = dom.container.querySelector('.tiptap')
  await dom.click('.composer-agent-identity button')
  const testedDetails = () => document.querySelector('.agent-state-face__facts')
  const details = testedDetails()
  expect(details?.textContent).toContain(new Date(now - 1000).toLocaleString())
  const before = rendererPerformance.snapshot().consumers.composer.visible.commits
  await act(async () => observe(session, now))
  expect(testedDetails()).toBe(details)
  expect(details?.textContent).toContain(new Date(now).toLocaleString())
  expect(rendererPerformance.snapshot().consumers.composer.visible.commits).toBe(before)
  expect(dom.container.querySelector('.tiptap')).toBe(editor)
})

it('updates the original Composer control when Agent status changes', async () => {
  const started = Date.now()
  observe(session, started)
  await show(true)
  const editor = dom.container.querySelector('.tiptap')
  const interrupt = '[aria-label="Interrupt the current turn"]'
  expect(dom.container.querySelector(interrupt)).toBeTruthy()
  await show(false)
  const before = rendererPerformance.snapshot().consumers.composer.hidden.commits
  await act(async () => observe(session, started + 1, 'done'))
  expect(rendererPerformance.snapshot().consumers.composer.hidden.commits).toBeGreaterThan(before)
  expect(dom.container.querySelector(interrupt)).toBeNull()
  await show(true)
  expect(dom.container.querySelector('.tiptap')).toBe(editor)
  expect(dom.container.querySelector('[aria-label="Send"]')).toBeTruthy()
})

it('sends through the real Store with the mounted Composer’s original pending request route', async () => {
  const original: typeof session = { ...session, inputEpoch: 'original-epoch',
    nativeHandle: { kind: 'provider', providerId: session.providerId, sessionId: 'original-native' },
    capabilities: { ...session.capabilities, nativeConversationInput: { managedRuns: true, interactionQueue: true, idleQueue: false } },
    pendingInteraction: { kind: 'permission', id: 'original-permission', agentSessionId: session.id, title: 'Original permission',
      options: [{ id: 'allow', kind: 'allow-once', label: 'Allow' }],
      evidence: { source: 'native-hook', observedAt: 1, run: session.control.run } } }
  useAppStore.setState({ sessions: [original] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (_control, _text, operationId, binding) => {
    if (!operationId || !binding) throw new Error('Original input binding is missing')
    const key = { kind: 'prompt' as const, agentSessionId: original.id, expectedRun: binding.expectedRun, submissionId: operationId }
    const ref = { key, waitGeneration: 1 }
    return { key, ref, persistence: 'confirmed', status: 'unknown', observation: 'unknown', admission: null,
      control: { ref, state: 'disabled', at: 2 } }
  })
  await show(true)
  await dom.click('[aria-label="Send"]')
  await act(async () => { await useAppStore.getState().flushAgentSteerQueue(original.id) })
  const [entry] = useAppStore.getState().agentSteerQueues[original.id] ?? []
  expect(entry).toMatchObject({ text: 'Keep my draft', inputReceipt: { status: 'unknown' } })
  expect(inspect.mock.calls[0]?.slice(0, 2)).toEqual([original.control,
    { kind: 'prompt', agentSessionId: original.id, expectedRun: original.control.run, submissionId: entry!.operationId }])
  expect(submit).toHaveBeenCalledOnce()
  expect(submit.mock.calls[0]?.slice(0, 4)).toEqual([original.control, 'Keep my draft', entry!.operationId,
    { expectedRun: original.control.run, inputEpoch: 'original-epoch', admissionIntent: {
      kind: 'native-conversation', source: { providerId: original.providerId, nativeSessionId: 'original-native' }
    } }])
  expect(useAppStore.getState().sessions[0]).toMatchObject({ pendingInteraction: { id: 'original-permission' }, control: original.control })
})

it('reconciles a later original Core refusal while the same Pane and editor stay hidden', async () => {
  const attempt: DesktopQuestionReplyAttempt = {
    hostId: session.hostId, phase: 'unknown',
    input: { source: { providerId: 'codex', nativeSessionId: 'original-native' }, turnId: 'original-turn', recordId: 'original-question',
      operationId: 'original-reply', expectedRun: session.control.run, afterSubmissionId: null,
      answers: [{ questionId: 'original-option', answer: 'Original frozen answer' }] }
  }
  const key = questionReplyKey(session.id, attempt.input)
  useAppStore.setState({ questionReplies: { [session.id]: { [key]: attempt } } })
  await show(true)
  const editor = dom.container.querySelector('.tiptap')
  const terminal = dom.container.querySelector<HTMLElement>('[data-run]')
  expect(editor?.textContent).toBe('Keep my draft')
  expect(terminal?.dataset.run).toBe(session.control.run.runId)
  await show(false)
  const before = rendererPerformance.snapshot().consumers.sessionPane.hidden.commits
  await act(async () => useAppStore.getState().applyEvent(questionRefusalEvent(session, 'another-reply')))
  expect(useAppStore.getState().questionReplies[session.id]?.[key]).toBe(attempt)
  await act(async () => useAppStore.getState().applyEvent(questionRefusalEvent(session, attempt.input.operationId, 3)))
  expect(useAppStore.getState().questionReplies[session.id]?.[key]).toMatchObject({ phase: 'rejected', input: attempt.input })
  expect(rendererPerformance.snapshot().consumers.sessionPane.hidden.commits).toBeGreaterThan(before)
  expect(dom.container.querySelector('.tiptap')).toBe(editor)
  expect(dom.container.querySelector('[data-run]')).toBe(terminal)
  expect(dom.draft()).toBe('Keep my draft')
})

it('shows the original unsettled Core answer in the retained Composer mailbox', async () => {
  const restorePopover = installNativePopover()
  try {
    const observedAt = Date.now()
    observe(session, observedAt)
    await show(true)
    const mailbox = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
    await act(async () => mailbox.showPopover())
    await dom.click('[role="tab"][id$="-system-tab"]')
    await show(false)
    const evidence = { source: 'native-hook' as const, observedAt: observedAt + 1, run: session.control.run }
    await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: {
      type: 'agent-session', session: {
        kind: 'agent', agentSessionId: session.control.agentSessionId, hostId: session.hostId, workspacePath: session.workspacePath,
        run: session.control.run, providerId: session.providerId, executorId: session.executorId, retiredRuns: [],
        createdAt: session.createdAt, updatedAt: evidence.observedAt,
        pendingInteraction: {
          request: { kind: 'permission', id: 'original-request', agentSessionId: session.id, title: 'Original permission', nativeToolCallId: 'original-tool-call',
            options: [{ id: 'allow', kind: 'allow-once', label: 'Allow' }], evidence },
          response: { value: { kind: 'permission', requestId: 'original-request', decision: { outcome: 'selected', optionId: 'allow' } },
            responseDigest: 'original-response-digest', operationId: 'original-answer', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false },
          nativeCompleted: evidence
        }
      }
    } }))
    expect(useAppStore.getState().sessions[0]).toMatchObject({ completedInteractionResponse: {
      requestId: 'original-request', operationId: 'original-answer', acknowledged: false
    } })
    await show(true)
    expect(dom.container.querySelector('.composer-mailbox')).toBe(mailbox)
    expect(mailbox.textContent).toContain('Typed answer receipt unsettled')
    expect(mailbox.textContent).toContain('earlier typed answer receipt is unconfirmed')
  } finally {
    restorePopover()
  }
})

it('returns to the original open input reading window after hidden capture', async () => {
  const restorePopover = installNativePopover()
  try {
    useAppStore.setState({ timelines: {}, viewModes: { [session.id]: 'terminal' } })
    await act(async () => capture(1, 2))
    await show(true)
    const mailbox = dom.container.querySelector<HTMLElement>('.composer-mailbox')!
    await act(async () => mailbox.showPopover())
    await dom.click('[role="tab"][id$="-user-tab"]')
    expect(mailbox.dataset.state).toBe('open')
    expect(mailbox.querySelector('[role="tab"][id$="-user-tab"]')?.getAttribute('aria-selected')).toBe('true')
    await show(false)
    expect(mailbox.dataset.state).toBe('closed')
    await act(async () => capture(2, 3))
    await show(true)
    expect(dom.container.querySelector('.composer-mailbox')).toBe(mailbox)
    expect(mailbox.dataset.state).toBe('open')
    expect(mailbox.querySelector('[role="tab"][id$="-user-tab"]')?.getAttribute('aria-selected')).toBe('true')
    expect(mailbox.textContent).toContain('Plan weekend trip')
  } finally {
    restorePopover()
  }
})

it('a standalone Composer reads captured inputs through its own Session lookup', async () => {
  useAppStore.setState({ timelines: {} })
  const showComposer = (visible: boolean) => dom.render(<AgentSessionComposer sessionId={session.id} visible={visible} />)
  await showComposer(true)
  const editor = dom.container.querySelector('.tiptap')
  expect(editor?.textContent).toBe('Keep my draft')
  await showComposer(false)
  await act(async () => capture(1, 2))
  await showComposer(true)
  expect(dom.container.querySelector('.tiptap')).toBe(editor)
  expect(dom.container.querySelector('.composer-agent-identity [aria-label]')?.getAttribute('aria-label')).toContain('Plan weekend trip')
})
