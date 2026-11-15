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

const dom = composerDOM(), session = composerSession(), origin = { workspaceId: 'workspace' }
const show = (visible: boolean) => dom.render(<SessionPane sessionId={session.id} surfaceKind="agent" visible={visible} linkOrigin={origin} interactiveResize={false} />)

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
