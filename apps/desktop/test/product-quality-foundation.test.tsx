// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { ServiceWindowNotice } from '../src/renderer/src/components/ServiceWindowNotice'
import { TerminalServiceNotices } from '../src/renderer/src/components/TerminalServiceNotices'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { AgentLifecycleFeedback } from '../src/renderer/src/components/AgentLifecycleFeedback'
import { agentLifecycleFailureNotice } from '../src/renderer/src/lib/agent-lifecycle-feedback'
import { useAppStore } from '../src/renderer/src/store'
import type { ContinuousProgressLoop } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { composerSession } from './helpers/composer-dom-fixture'
import { composerConfig } from './helpers/composer-dom-fixture'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import type { RenderableServiceNotice } from '../src/renderer/src/lib/service-window-notice'

let container: HTMLDivElement, root: Root
const initial = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks() })

const notice: RenderableServiceNotice = { kind: 'process-degraded', notice: {
  step: 'Confirming replay geometry did not complete',
  mode: 'The terminal remains available. Retained output layout cannot be confirmed because its original size is unknown.',
  restore: 'Resize this pane to retry the current screen; historical layout cannot be reconstructed. FINAL RESTORATION FACT.'
} }
const summary = { step: 'Replay layout unconfirmed', mode: 'Terminal usable; retained layout is unknown.', restore: 'Resize to retry; historical layout remains unconfirmed.' }
const progressTrigger = () => container.querySelector<HTMLButtonElement>('.composer__mailbox')!
async function renderProgress() {
  useAppStore.setState({ config: composerConfig, sessions: [composerSession()] })
  await act(async () => root.render(<AgentSessionComposer sessionId="agent-1" />))
}
async function mailboxToggle(newState: 'open' | 'closed') {
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: newState })
  await act(async () => container.querySelector('.composer-mailbox')!.dispatchEvent(event))
}
async function openProgress() {
  await mailboxToggle('open')
  await act(async () => container.querySelector<HTMLButtonElement>('[id$="-progress-tab"]')!.click())
}

it('mounts persistent truthful three-fact summary and explicit complete details without taking existing input focus', async () => {
  const input = document.createElement('textarea'); document.body.append(input); input.focus()
  try {
    await act(async () => root.render(<ServiceWindowNotice {...{ notice, summary }} />))
    const body = container.querySelector('.service-window__body')!
    expect(body.textContent).toContain(summary.step)
    expect(body.textContent).toContain(summary.mode)
    expect(body.textContent).toContain(summary.restore)
    const details = container.querySelector<HTMLDetailsElement>('.service-window__details')
    expect(details).not.toBeNull()
    expect(details!.open).toBe(false)
    expect(details!.textContent).toContain(notice.notice.step)
    expect(details!.textContent).toContain(notice.notice.mode)
    expect(details!.textContent).toContain('FINAL RESTORATION FACT.')
    expect(details!.querySelector('[tabindex="0"]')).not.toBeNull()
    expect(document.activeElement).toBe(input)
    details!.open = true; details!.open = false
    expect(body.textContent).toContain(summary.mode)
    expect(container.querySelector('[role="status"]')!.getAttribute('aria-live')).toBe('polite')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
  } finally { input.remove() }
})

it('a rejected mounted progress list remains unconfirmed on the closed mailbox, with complete cause and manual input kept', async () => {
  const dispose = vi.fn()
  vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => dispose)
  vi.spyOn(api.continuousProgress, 'list').mockRejectedValue(new Error('Original list cause FINAL CAUSE'))
  await renderProgress()
  await vi.waitFor(() => expect(container.textContent).toContain('FINAL CAUSE'))
  expect(container.querySelector('.composer-mailbox')!.getAttribute('data-state')).toBe('closed')
  expect(progressTrigger().getAttribute('data-progress-state')).toBe('unconfirmed')
  expect(progressTrigger().title).toContain('unconfirmed')
  expect(container.textContent).toContain('Manual input follows terminal readiness')
  await act(async () => root.unmount())
  expect(dispose).toHaveBeenCalledTimes(1)
})

it('keeps each original Terminal capability distinct, unknown honest and complete causes reachable, without inventing recovery buttons', async () => {
  const unknown: RenderableServiceNotice = { kind: 'indeterminate', notice: {
    step: 'Original size failure', mode: 'We cannot confirm whether the Agent itself is affected.', restore: 'Original resize path FINAL UNKNOWN ACTION'
  } }
  await act(async () => root.render(<TerminalServiceNotices reveal={notice} replayGeometry={unknown}
    viewportSync={notice} continuation={notice} />))
  const notices = [...container.querySelectorAll('.service-window')]
  expect(notices).toHaveLength(4)
  expect(notices.map(n => n.querySelector('.service-window__step')!.textContent)).toEqual([
    'Terminal restoration unconfirmed', 'Replay layout unconfirmed', 'Terminal size unconfirmed', 'Terminal state unconfirmed'
  ])
  expect(notices[1]!.querySelector('.service-window__mode')!.textContent).toBe(unknown.notice.mode)
  expect(notices[1]!.querySelector('.service-window__details')!.textContent).toContain('FINAL UNKNOWN ACTION')
  expect(notices.map(n => n.getAttribute('role'))).toEqual(['status', 'status', 'status', 'status'])
  expect(container.querySelectorAll('button')).toHaveLength(0)
  expect(container.querySelectorAll('.service-window__details')).toHaveLength(4)
})

it('allocates no notice track when all existing facts are healthy', async () => {
  await act(async () => root.render(<TerminalServiceNotices reveal={null} replayGeometry={null} viewportSync={null} continuation={null} />))
  expect(container.innerHTML).toBe('')
})

it('keeps the real Progress form mounted through page switching and mailbox closing, without another observer or action', async () => {
  const observe = vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
  const list = vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  const action = vi.spyOn(api.continuousProgress, 'action')
  await renderProgress()
  expect(container.querySelectorAll('[id$="-progress-tab"]')).toHaveLength(1)
  expect(container.querySelectorAll('.composer__mailbox')).toHaveLength(1)
  expect(container.querySelector('.composer > .continuous-progress-control')).toBeNull()
  await openProgress()
  const form = container.querySelector<HTMLFormElement>('.continuous-progress-control form')!
  expect(form).not.toBeNull()
  const textarea = form.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Kept continuation draft')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    container.querySelector<HTMLButtonElement>('[id$="-inbox-tab"]')!.click()
  })
  await mailboxToggle('closed'); await openProgress()
  expect(container.querySelector('.continuous-progress-control form')).toBe(form)
  expect(textarea.value).toBe('Kept continuation draft')
  expect(observe).toHaveBeenCalledTimes(1)
  expect(list).toHaveBeenCalledTimes(1)
  expect(action).not.toHaveBeenCalled()
})

it('global and lifecycle consumers retain their complete three facts, polite ARIA and only their own recovery actions', async () => {
  const session = composerSession()
  const failure = { step: 'resume' as const, subject: session.control, lastProcessState: 'running' as const }
  useAppStore.setState({ sessions: [], loading: false, environmentWarning: 'Original shell cause', runtimeOwnershipWarnings: [],
    displacedAgentSessionIds: [], error: null, errorNoticeContext: undefined })
  await act(async () => root.render(<GlobalSystemNotices />))
  const global = container.querySelector('.service-window')!
  expect(global.querySelector('.service-window__step')!.textContent).toBe('Local shell environment is incomplete')
  expect(global.querySelector('.service-window__mode')!.textContent).toBe('Original shell cause')
  expect(global.querySelector('.service-window__restore')!.textContent).toContain('Check your shell startup scripts')
  expect(global.getAttribute('aria-live')).toBe('polite')
  expect(container.querySelector('.global-system-notices__action')).toBeNull()
  await act(async () => useAppStore.setState({ error: 'Original lifecycle cause', errorDismissed: false, errorNoticeContext: { kind: 'indeterminate', lifecycle: failure } }))
  const retry = vi.fn()
  await act(async () => root.render(<AgentLifecycleFeedback owner={{ subject: session.control }} retry={retry} />))
  const expected = agentLifecycleFailureNotice(failure, 'Original lifecycle cause')
  const local = container.querySelector('.service-window')!
  expect(local.querySelector('.service-window__step')!.textContent).toBe(expected.notice.step)
  expect(local.querySelector('.service-window__mode')!.textContent).toContain('availability unconfirmed')
  expect(local.querySelector('.service-window__mode')!.textContent).toContain('last observed running')
  const original = local.querySelector('.service-window__original')!
  expect(original.textContent).toContain(expected.notice.step)
  expect(original.textContent).toContain(expected.notice.mode)
  expect(original.textContent).toContain(expected.notice.restore)
  expect(local.getAttribute('aria-live')).toBe('polite')
  expect(local.querySelectorAll('button')).toHaveLength(0)
  const retryButton = [...container.querySelectorAll('button')].find(b => b.textContent === 'Retry Resume')!
  await act(async () => retryButton.click())
  expect(retry).toHaveBeenCalledTimes(1)
})

const loop: ContinuousProgressLoop = { loopId: 'owned-loop', hostId: 'local', agentSessionId: 'agent-1', providerId: 'codex',
  workspacePath: '/repo', intervalMs: 60_000, prompt: 'Continue the original task', nextCheckAt: 60_000, status: 'active' }

it('a rejected mounted progress action remains visible on closing, preserves complete cause and keeps the exact target', async () => {
  vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([loop])
  const action = vi.spyOn(api.continuousProgress, 'action').mockRejectedValue(new Error('Original action cause FINAL ACTION CAUSE'))
  await renderProgress()
  await vi.waitFor(() => expect(container.querySelector('[aria-label="Pause continuous progress"]')).not.toBeNull())
  await openProgress()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pause continuous progress"]')!.click())
  await mailboxToggle('closed')
  expect(progressTrigger().getAttribute('data-progress-state')).toBe('unconfirmed')
  expect(container.textContent).toContain('FINAL ACTION CAUSE')
  expect(action.mock.calls).toEqual([[{ hostId: 'local', agentSessionId: 'agent-1', providerId: 'codex', workspacePath: '/repo' }, 'owned-loop', 'pause']])
  expect(container.querySelectorAll('.continuous-progress-control')).toHaveLength(1)
})

it('current loop unknown outcome remains visible even without a rejected call, and disposal rejects unrelated or late list updates', async () => {
  const dispose = vi.fn()
  let changed: ((loop: ContinuousProgressLoop) => void) | undefined
  vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(fn => { changed = fn; return dispose })
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([{ ...loop, lastOutcome: 'unknown', lastDecision: 'Original admission unknown' }])
  await renderProgress()
  await vi.waitFor(() => expect(progressTrigger().getAttribute('data-progress-state')).toBe('unconfirmed'))
  await act(async () => changed!({ ...loop, agentSessionId: 'unrelated-agent', lastOutcome: 'sent' }))
  expect(progressTrigger().getAttribute('data-progress-state')).toBe('unconfirmed')
  await act(async () => root.unmount())
  expect(dispose).toHaveBeenCalledTimes(1)
})

it.each(['interrupted', 'attachment-pending'] as const)('the actual Session Composer host never declares input ready after a rejected list: %s', async state => {
  const session = composerSession()
  if (state === 'interrupted') { session.processState = 'interrupted'; session.status = { state: 'disconnected', source: 'run-process', observedAt: 1 } }
  useAppStore.setState({ config: composerConfig, sessions: [session], agentComposerDrafts: { 'agent-1': 'Preserved draft' } })
  vi.spyOn(api.continuousProgress, 'onChanged').mockImplementation(() => vi.fn())
  vi.spyOn(api.continuousProgress, 'list').mockRejectedValue(new Error('Readiness unknown FINAL HOST CAUSE'))
  await act(async () => root.render(<AgentSessionComposer sessionId="agent-1" disabled={state === 'attachment-pending'} />))
  await vi.waitFor(() => expect(container.textContent).toContain('FINAL HOST CAUSE'))
  // Interrupted hosts deliberately keep a writable restore draft; that is not proof of a ready Run.
  expect(container.querySelector('.tiptap')!.getAttribute('contenteditable')).toBe(state === 'attachment-pending' ? 'false' : 'true')
  if (state === 'interrupted') expect(container.querySelector('.tiptap')!.getAttribute('data-placeholder')).toContain('restore this Agent')
  expect(progressTrigger().getAttribute('data-progress-state')).toBe('unconfirmed')
  expect(container.textContent).not.toMatch(/manual input remains available/i)
  expect(useAppStore.getState().agentComposerDrafts['agent-1']).toBe('Preserved draft')
})
