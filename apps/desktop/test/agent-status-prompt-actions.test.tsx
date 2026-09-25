// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxInteractionRequest, AgentMuxInteractionResponse } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
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
const buttons = () => [...dom.container.querySelectorAll<HTMLButtonElement>('.agent-status-prompts button')]
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
    expect(buttons().map((button) => button.textContent)).toEqual([configured(state).label])
    expect(buttons()[0]!.getAttribute('aria-label')).toBe(`Send ${configured(state).label}`)
    await click(); await drained()
    expect(send).toHaveBeenCalledWith(sessionId, configured(state).body, expect.any(Function))
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
    expect(buttons().map((button) => button.textContent)).toEqual([universal.label])
    await act(async () => useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [{ ...universal, label: '即时编辑', body: '新的正文' }] } }))
    expect(buttons().map((button) => button.textContent)).toEqual(['即时编辑'])
    await click(); await drained()
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls.map((call) => call[1])).toEqual(['新的正文'])
    await act(async () => useAppStore.setState({ config: { ...composerConfig, composerShortcuts: [{ ...universal, states: [] }, other] } }))
    expect(dom.container.querySelector('.agent-status-prompts')).toBeNull()
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
    expect(buttons()[0]!.textContent).toBe(`Queue ·${configured('running').label}`)
    expect(buttons()[0]!.getAttribute('aria-label')).toBe(`Queue ${configured('running').label}`)
    await click(); await drained()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions[0]).toEqual(original)
    expect(useAppStore.getState().agentSteerQueues[sessionId]?.map(({ text, runId }) => ({ text, runId }))).toEqual([
      { text: configured('running').body, runId: original.control.run.runId }
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
    expect(buttons()).toHaveLength(1); expect(buttons()[0]!.disabled).toBe(true)
    await click(); await drained()
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentSteerQueues).toEqual({})
    expect(dom.draft()).toBe(draft)
  })
  it('retains configured text in the existing retry queue when typed submission fails', async () => {
    vi.mocked(api.sessions.submitPrompt).mockRejectedValueOnce(new Error('temporarily busy'))
    await dom.render(<AgentSessionComposer sessionId={sessionId} />)
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

it('keeps its row present across bound/unbound states and exposes complete long labels', async () => {
  const prompt = { ...configured('done'), label: '大白话说清楚目标与现状、完成内容质量品位，以及下一步工作的价值和重点' }
  const selected = vi.fn()
  await dom.render(<AgentStatusPromptActions prompts={[prompt]} state="running" disabled={false} queue={false} onSelect={selected} />)
  expect(dom.container.querySelector('.agent-status-prompts')).not.toBeNull(); expect(buttons()).toEqual([])
  await dom.render(<AgentStatusPromptActions prompts={[prompt]} state="done" disabled={false} queue={false} onSelect={selected} />)
  expect(buttons()).toHaveLength(1); expect(buttons()[0]!.getAttribute('aria-label')).toBe(`Send ${prompt.label}`)
  expect(buttons()[0]!.title).toBe(prompt.body)
  await click(); expect(selected).toHaveBeenCalledWith(prompt)
})
