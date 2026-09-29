// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentAvatar } from '../src/renderer/src/components/AgentAvatar'
import { AgentInteractionCard } from '../src/renderer/src/components/AgentInteractionCard'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionResultReviewContent } from '../src/renderer/src/components/SessionResultReviewContent'
import { AgentStatusPromptActions } from '../src/renderer/src/components/AgentStatusPromptActions'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { COMPOSER_PROMPT_STATES } from '../src/shared/composer-shortcut-library'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { ComposerShortcut } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

const dom = composerDOM(), sessionId = 'agent-1', draft = 'Keep my independently authored draft'
let disposeBootstrap: (() => void) | undefined
beforeAll(async () => { disposeBootstrap = await useAppStore.getState().initialize() })
afterAll(() => disposeBootstrap?.())
const prompts: ComposerShortcut[] = COMPOSER_PROMPT_STATES.map((state) => ({ id: state, keyword: state,
  label: `Action for ${state}`, body: `Configured ${state} prompt\n  exact inner spacing`, states: [state] }))
beforeEach(() => {
  const tab = createWorkbenchTab('status-prompt-tab', { regionId: 'status-prompt-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId })
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: prompts },
    agentComposerDrafts: { [sessionId]: draft }, agentSteerQueues: {}, agentSteerInFlight: {},
    noticeReadReceipts: {}, timelines: {}, tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('status-prompt-group', [tab.id]) }, activeWorkspaceId: 'workspace' })
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async (control) => {
    const session = useAppStore.getState().sessions.find((item) => item.id === control.agentSessionId)
    if (!session) throw new Error('Original Session absent')
    return session
  })
  vi.spyOn(api.sessions, 'recover').mockImplementation(async () => ({ kind: 'resumed', session: {
    ...composerSession(), control: { ...composerSession().control, run: { runId: 'restored-original-agent' } }
  } }))
})
afterEach(async () => { await useAppStore.getState().flushAgentSteerQueue(sessionId) })
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.agent-status-prompts button')]
const labels = () => buttons().map(button => button.querySelector('.agent-status-prompts__label')!.textContent)
async function open() { await dom.click('.composer-agent-identity .agent-avatar') }
const configured = (state: string) => prompts.find((prompt) => prompt.id === state)!
async function click() { expect(buttons()).toHaveLength(1); await act(async () => {
  buttons()[0]!.click(); await useAppStore.getState().flushAgentSteerQueue(sessionId)
}) }
async function drained() { await act(async () => { await useAppStore.getState().flushAgentSteerQueue(sessionId) }) }

describe('state Prompt actions mounted through the actual Session composer and Store', () => {
  it.each(COMPOSER_PROMPT_STATES)('dispatches the %s body to the original Session and keeps its draft', async (state) => {
    const session = { ...composerSession(), processState: state === 'exited' ? 'exited' as const : 'running' as const,
      status: { state, source: 'run-process' as const, observedAt: 1 } }
    useAppStore.setState({ sessions: [session] })
    const send = vi.spyOn(useAppStore.getState(), 'send')
    await dom.render(<AgentSessionComposer sessionId={sessionId} />)
    await open()
    expect(labels()).toEqual([configured(state).label])
    expect(buttons()[0]!.getAttribute('aria-label')).toBe(`Send ${configured(state).label}`)
    await click(); await drained()
    expect(send).toHaveBeenCalledWith(sessionId, configured(state).body, expect.any(Function), 'manual')
    const calls = vi.mocked(api.sessions.submitPrompt).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0]![0].agentSessionId).toBe(sessionId)
    expect(calls[0]![1]).toBe(configured(state).body)
    const expectedRun = { runId: state === 'exited' || state === 'disconnected' ? 'restored-original-agent' : `run-${sessionId}` }
    expect(calls[0]![0].run).toEqual(expectedRun)
    expect(calls[0]![2]).toEqual(expect.any(String))
    expect(calls[0]![3]).toEqual({ expectedRun, afterSubmissionId: null })
    if (state === 'exited' || state === 'disconnected') expect(api.sessions.recover).toHaveBeenCalledOnce()
    else expect(api.sessions.recover).not.toHaveBeenCalled()
    expect(dom.draft()).toBe(draft)
    expect(useAppStore.getState().sessions.map((item) => item.id)).toEqual([sessionId])
  })
  it('uses live Provider-bound configuration and leaves no rail when all bindings are absent', async () => {
    const universal = { ...configured('running'), id: 'universal' }, other = { ...configured('running'), id: 'other', providerId: 'claude' }
    useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [universal, other] } })
    await dom.render(<AgentSessionComposer sessionId={sessionId} />)
    await open()
    expect(labels()).toEqual([universal.label])
    await act(async () => useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [{ ...universal, label: '即时编辑', body: '新的正文' }] } }))
    expect(labels()).toEqual(['即时编辑'])
    await click(); await drained()
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map((call) => call[1])).toEqual(['新的正文'])
    await act(async () => useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [{ ...universal, states: [] }, other] } }))
    await open(); expect(document.querySelector('.agent-status-prompts')).toBeNull()
  })
  it.each(['permission', 'question'] as const)('explicitly Queues during a typed %s and drains only after its real response path', async (kind) => {
    const evidence = { source: 'native-hook' as const, observedAt: 2, run: composerSession().control.run }
    const request: AgentMuxInteractionRequest = kind === 'permission'
      ? { kind, id: 'request', agentSessionId: sessionId, title: 'Allow command?', options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence }
      : { kind, id: 'request', agentSessionId: sessionId, questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'choice', label: 'Choice' }] }], evidence }
    const original = { ...composerSession(), pendingInteraction: request }
    useAppStore.setState({ sessions: [original] })
    const reply = vi.spyOn(api.sessions, 'respondInteraction').mockImplementation(async () => {
      const { pendingInteraction: _answered, ...session } = original
      useAppStore.setState({ sessions: [session] })
    })
    await dom.render(<AgentSessionComposer sessionId={sessionId} />)
    await open()
    expect(buttons()[0]!.querySelector('.agent-status-prompts__intent')!.textContent).toBe('Queue')
    expect(buttons()[0]!.getAttribute('aria-label')).toBe(`Queue ${configured('running').label}`)
    await click(); await drained()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]).toEqual(original)
    expect(useAppStore.getState().agentSteerQueues[sessionId]?.map(({ text, runId, origin }) => ({ text, runId, origin }))).toEqual([
      { text: configured('running').body, runId: original.control.run.runId, origin: 'manual' }
    ])
    expect(dom.draft()).toBe(draft)
    const response: AgentMuxInteractionResponse = kind === 'permission'
      ? { kind, requestId: 'request', decision: { outcome: 'selected', optionId: 'allow' } }
      : { kind, requestId: 'request', outcome: 'answered', answers: [{ questionId: 'q', optionId: 'choice' }] }
    await act(async () => useAppStore.getState().respondInteraction(sessionId, response))
    expect(reply).toHaveBeenCalledWith(original.control, response)
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map((call) => call[1])).toEqual([configured('running').body])
    expect(dom.draft()).toBe(draft)
  })
  it.each([{ readOnly: true }, { disabled: true }])('never sends through a disabled surface %o', async (props) => {
    await dom.render(<AgentSessionComposer sessionId={sessionId} {...props} />)
    await open()
    expect(buttons()).toHaveLength(1); expect(buttons()[0]!.disabled).toBe(true)
    await click(); await drained()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues).toEqual({})
    expect(dom.draft()).toBe(draft)
  })
  it('retains configured text in the existing retry queue when typed submission fails', async () => {
    vi.mocked(api.sessions.submitPrompt).mockRejectedValueOnce(new Error('temporarily busy'))
    await dom.render(<AgentSessionComposer sessionId={sessionId} />)
    await open()
    await click()
    const entries = useAppStore.getState().agentSteerQueues[sessionId]
    expect(entries?.map(({ text, status, error }) => ({ text, status, error }))).toEqual([
      { text: configured('running').body, status: 'deferred', error: 'temporarily busy' }
    ])
    expect(dom.draft()).toBe(draft)
    await act(async () => useAppStore.getState().sendQueuedAgentSteer(sessionId, entries![0]!.operationId))
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map((call) => call[1])).toEqual([configured('running').body, configured('running').body])
  })
})

it('omits the complete section when the current state has no matches and exposes complete long labels', async () => {
  const prompt = { ...configured('done'), label: '大白话说清楚目标与现状、完成内容质量品位，以及下一步工作的价值和重点' }
  const selected = vi.fn()
  await dom.render(<AgentStatusPromptActions prompts={[prompt]} state="running" disabled={false} queue={false} onSelect={selected} />)
  expect(dom.container.querySelector('.agent-status-prompts')).toBeNull(); expect(buttons()).toEqual([])
  await dom.render(<AgentStatusPromptActions prompts={[prompt]} state="done" disabled={false} queue={false} onSelect={selected} />)
  expect(buttons()).toHaveLength(1); expect(buttons()[0]!.getAttribute('aria-label')).toBe(`Send ${prompt.label}`)
  expect(buttons()[0]!.title).toBe(prompt.body)
  await click(); expect(selected).toHaveBeenCalledWith(prompt)
})


it('uses the one existing avatar face for preview and pin, closes on Escape without reopening, and preserves a later outside focus', async () => {
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  const trigger = dom.container.querySelector<HTMLButtonElement>('.composer-agent-identity .agent-avatar')!
  expect(trigger.tagName).toBe('BUTTON')
  expect(dom.container.querySelector('.agent-status-prompts')).toBeNull()
  expect(dom.container.querySelector('.session-result-review-slot')).toBeNull()
  await dom.hover('.composer-agent-identity .agent-avatar')
  const preview = document.getElementById(trigger.getAttribute('aria-controls')!)!
  expect(preview.querySelectorAll('.agent-status-prompts button')).toHaveLength(1)
  await open()
  expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(preview)
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }))
    await new Promise(resolve => setTimeout(resolve, 200))
  })
  expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBe(preview)
  await act(async () => {
    preview.querySelector<HTMLButtonElement>('.agent-status-prompts button')!.focus()
    preview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
  expect(document.getElementById(trigger.getAttribute('aria-controls')!)).toBeNull()
  await open()
  const outside = document.createElement('button'); document.body.append(outside)
  await act(async () => { outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); outside.focus() })
  expect(document.activeElement).toBe(outside)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  outside.remove()
  expect(dom.draft()).toBe(draft)
})

it('has no section for another exact state, never invents formal readiness, and drops old actions when hidden or switched', async () => {
  useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [configured('working')] } })
  await dom.render(<AgentSessionComposer sessionId={sessionId} />); await open()
  const trigger = dom.container.querySelector<HTMLButtonElement>('.agent-avatar')!
  const face = document.getElementById(trigger.getAttribute('aria-controls')!)!
  expect(face.querySelector('.agent-status-prompts')).toBeNull()
  expect(face.textContent).toContain('Status unknown')
  const readiness = [...face.querySelectorAll('dt')].find(item => item.textContent === 'Prompt readiness')!
  expect(readiness.nextElementSibling!.textContent).toBe('Not reported')
  const statement = [...face.querySelectorAll('dt')].find(item => item.textContent === 'Agent statement')!
  expect(statement.nextElementSibling!.textContent).toBe('Not reported')
  await dom.render(<AgentSessionComposer sessionId={sessionId} visible={false} />)
  expect(document.querySelector('.agent-identity-popover--actions')).toBeNull()
  const next = composerSession('next')
  await act(async () => useAppStore.setState({ sessions: [composerSession(), next] }))
  await dom.render(<AgentSessionComposer sessionId="next" />)
  expect(document.querySelector('.agent-identity-popover--actions')).toBeNull()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('mounts the actual Review owner only after explicit Review and releases it on Back, hiding and state changes', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'agentmux')
  const git = vi.fn(async () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/repo' }))
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { status: git } } })
  try {
    useAppStore.setState({ sessions: [{ ...composerSession(), status: { state: 'done', source: 'native-hook', observedAt: Date.now() } }] })
    const render = (visible = true) => dom.render(<AgentSessionComposer sessionId={sessionId} visible={visible}
      resultReview={onNavigate => <SessionResultReviewContent sessionId={sessionId} items={[]} origin={{ workspaceId: 'workspace', tabGroupId: 'status-prompt-group' }} onNavigate={onNavigate} />} />)
    await render()
    expect(git).not.toHaveBeenCalled()
    await dom.hover('.composer-agent-identity .agent-avatar')
    expect(git).not.toHaveBeenCalled()
    await open()
    expect(git).not.toHaveBeenCalled()
    const face = document.querySelector<HTMLElement>('.agent-identity-popover--actions')!
    await act(async () => { const action = face.querySelector<HTMLButtonElement>('.agent-state-face__review')!; action.focus(); action.click() })
    expect(document.activeElement).toBe(face.querySelector('.agent-state-face__summary button'))
    await vi.waitFor(() => expect(git).toHaveBeenCalledExactlyOnceWith('workspace'))
    expect(face.querySelector('[popover]')).toBeNull()
    const neighbor = { ...composerSession(), id: 'unrelated-agent', status: { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() } }
    await act(async () => { for (let i = 0; i < 20; i++) useAppStore.setState({ sessions: [useAppStore.getState().sessions.find(session => session.id === sessionId)!, { ...neighbor, status: { ...neighbor.status, observedAt: i } }] }) })
    expect(git).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.agent-identity-popover--actions')).toBe(face)
    expect(face.querySelector('.session-result-review__details')!.textContent).toContain('not a Git repository')
    await act(async () => face.querySelector<HTMLButtonElement>('.agent-state-face__summary button')!.click())
    expect(document.activeElement).toBe(face.querySelector('.agent-state-face__review'))
    expect(face.querySelector('.session-result-review__details')).toBeNull()
    expect(git).toHaveBeenCalledTimes(1)
    await act(async () => face.querySelector<HTMLButtonElement>('.agent-state-face__review')!.click())
    expect(git).toHaveBeenCalledTimes(2)
    await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), status: { state: 'working', source: 'native-hook', observedAt: Date.now() } }] }))
    expect(face.querySelector('.session-result-review__details')).toBeNull()
    await render(false)
    expect(document.querySelector('.agent-identity-popover--actions')).toBeNull()
    expect(git).toHaveBeenCalledTimes(2)
  } finally {
    if (descriptor) Object.defineProperty(window, 'agentmux', descriptor)
    else Reflect.deleteProperty(window, 'agentmux')
  }
})

it('prefers an actually reported semantic statement over a separate unavailable timeline capability', async () => {
  const session = composerSession()
  useAppStore.setState({ sessions: [{ ...session, capabilities: { ...session.capabilities, timeline: 'unavailable' },
    semanticStatus: { state: 'waiting', source: 'native-hook', observedAt: Date.now() } }] })
  await dom.render(<AgentSessionComposer sessionId={sessionId} />)
  await open()
  const terms = Array.from(document.querySelectorAll('.agent-state-face__facts dt'))
  expect(terms.length).toBeGreaterThan(0)
  const statement = terms.find(term => term.textContent === 'Agent statement')!.nextElementSibling!
  expect(statement.textContent).toContain('Waiting · native-hook')
  expect(statement.textContent).not.toContain('Not supported')
})

it('preserves the existing Focus disclosure object, delayed preview, mark and onOpen navigation', async () => {
  const navigate = vi.fn()
  const bounds = vi.fn(() => new DOMRect(220, 260, 120, 24))
  const reference = vi.fn(() => ({ getBoundingClientRect: bounds }))
  const disclosure = { label: 'Original Focus context', scope: 'focus-owner', content: <p>Retained Focus preview</p>, reference, mark: <span data-focus-mark>Original mark</span> }
  await dom.render(<AgentAvatar label="Focus receiver" onOpen={navigate} disclosure={disclosure} />)
  expect(dom.container.querySelector('[data-focus-mark]')!.textContent).toBe('Original mark')
  await dom.hover('.agent-avatar')
  expect(document.querySelector('.recent-focus__context-preview')).toBeNull()
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 210)) })
  const preview = document.querySelector<HTMLElement>('.recent-focus__context-preview')!
  expect(preview.getAttribute('role')).toBe('tooltip')
  expect(preview.getAttribute('aria-label')).toBe('Original Focus context')
  expect(preview.textContent).toBe('Retained Focus preview')
  expect(reference).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(preview.style.visibility).toBe('visible'))
  expect(bounds).toHaveBeenCalled()
  expect(Number.parseFloat(preview.style.top)).toBeGreaterThan(200)
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(document.querySelector('.recent-focus__context-preview')).toBe(preview)
  await dom.click('.agent-avatar')
  expect(navigate).toHaveBeenCalledExactlyOnceWith()
  expect(document.querySelector('.recent-focus__context-preview')).toBeNull()
})

it.each([
  { terminalBottom: 88.6, composerTop: 220, expectedTop: 94.6, expectedHeight: 119.4 },
  { terminalBottom: 300, composerTop: 310, expectedTop: 62, expectedHeight: 200 }
])('places the actual action face in readable space around the native input band: %o', async ({ terminalBottom, composerTop, expectedTop, expectedHeight }) => {
  const request: AgentMuxInteractionRequest = { kind: 'question', id: 'geometry-question', agentSessionId: sessionId,
    questions: [{ id: 'q', prompt: 'Which?', options: [{ id: 'choice', label: 'Choice' }] }],
    evidence: { source: 'native-hook', observedAt: 2, run: composerSession().control.run } }
  const original = { ...composerSession(), pendingInteraction: request }, respond = vi.fn()
  useAppStore.setState({ sessions: [original] })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.workbenchRegionId) return new DOMRect(0, 0, 320, 430)
    if (this.classList.contains('terminal-view__xterm')) return new DOMRect(0, 40, 320, terminalBottom - 40)
    if (this.classList.contains('composer')) return new DOMRect(0, composerTop, 320, 100)
    if (this.classList.contains('agent-avatar')) return new DOMRect(280, composerTop + 10, 24, 24)
    if (this.classList.contains('agent-identity-popover')) {
      const maximum = Number.parseFloat(this.style.maxHeight)
      return new DOMRect(Number.parseFloat(this.style.left) || 0, Number.parseFloat(this.style.top) || 0, 296,
        Math.min(200, Number.isFinite(maximum) ? maximum : 200))
    }
    return new DOMRect()
  })
  await dom.render(<div data-workbench-region-id="geometry-owner"><section className="agent-surface">
    <div className="agent-body"><div className="terminal-view__xterm" /><AgentInteractionCard request={request} onRespond={respond} /></div>
    <AgentSessionComposer sessionId={sessionId} />
  </section></div>)
  const card = dom.container.querySelector<HTMLElement>('.agent-interaction')!, cardText = card.textContent
  const answer = card.querySelector<HTMLButtonElement>('button')!
  expect(answer.disabled).toBe(false)
  await open()
  const panel = document.querySelector<HTMLElement>('.agent-identity-popover--actions')!, bounds = panel.getBoundingClientRect()
  expect(bounds.top).toBeCloseTo(expectedTop)
  expect(bounds.height).toBeCloseTo(expectedHeight)
  expect(bounds.height).toBeGreaterThan(100)
  expect(bounds.bottom).toBeLessThanOrEqual(composerTop - 5)
  expect(bounds.bottom <= terminalBottom - 32 - 5 || bounds.top >= terminalBottom + 5).toBe(true)
  expect(buttons()[0]!.getAttribute('aria-label')).toBe('Queue Action for running')
  await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Close Agent status"]')!.click())
  expect(document.querySelector('.agent-identity-popover--actions')).toBeNull()
  expect(dom.container.querySelector('.agent-interaction')).toBe(card)
  expect(card.textContent).toBe(cardText)
  expect(answer.disabled).toBe(false)
  expect(respond).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions[0]).toEqual(original)
  expect(dom.draft()).toBe(draft)
})
