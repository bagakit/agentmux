// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
import { observeWorkbenchStorageAuthority, requireWorkbenchStorageAuthority } from '../src/main/workbench-storage-authority.js'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer.js'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore, prepareRendererUpdate, type AgentSteerQueueEntry } from '../src/renderer/src/store.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture.js'

const initial = useAppStore.getState()
const session = composerSession()
const tab = createWorkbenchTab('original-view', { kind: 'agent', regionId: 'original-region', workspaceId: 'workspace', sessionId: session.id, phase: 'attached' })
let dispose: () => void
let temporary: string
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  localStorage.clear()
  dispose = await useAppStore.getState().initialize()
  temporary = await mkdtemp('/tmp/amx-message-save-')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  useAppStore.setState({ config: composerConfig, sessions: [session], loading: false, activeWorkspaceId: 'workspace',
    tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('pane', [tab.id]) }, agentSteerQueues: {}, agentSteerInFlight: {}, agentComposerDrafts: { [session.id]: 'Retained draft' },
    workbenchSaveWarning: null, error: null })
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); dispose()
  vi.restoreAllMocks(); useAppStore.setState(initial, true)
  await rm(temporary, { recursive: true })
})

function entry(id: string, overrides: Partial<AgentSteerQueueEntry> = {}): AgentSteerQueueEntry {
  return { operationId: id, runId: session.control.run.runId, text: `Message ${id}`, status: 'queued',
    promptCondition: { expectedRun: session.control.run, afterSubmissionId: null }, ...overrides }
}
async function missingStorage() {
  await mkdir(join(temporary, 'Local Storage'))
  const observed = await observeWorkbenchStorageAuthority({ getStoragePath: () => temporary }, { userData: temporary, sessionData: temporary })
  expect(observed.localStorage).toBe('missing')
  // Same product guard as the real IPC; no persistent user directory or Native is used.
  return vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => requireWorkbenchStorageAuthority(observed))
}
async function renderComposer() {
  await act(async () => root.render(<><AgentSessionComposer sessionId={session.id} /><GlobalSystemNotices /></>))
}
async function clickText(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.startsWith(label))
  expect(button).toBeDefined(); expect(button!.disabled).toBe(false)
  await act(async () => button!.click())
}

it('previous Composer success, persistent save refusal, then actual outbox Send preserves identity without sending the tail', async () => {
  const submit = vi.mocked(api.sessions.submitPrompt)
  await renderComposer()
  await act(async () => {
    useAppStore.getState().setAgentComposerDraft(session.id, 'Earlier accepted message')
  })
  const send = container.querySelector<HTMLButtonElement>('.composer-send')
  expect(send).not.toBeNull(); expect(send!.disabled).toBe(false)
  await act(async () => { send!.click(); await useAppStore.getState().flushAgentSteerQueue(session.id) })
  expect(submit.mock.calls).toEqual([[session.control, 'Earlier accepted message', expect.any(String),
    { expectedRun: session.control.run, afterSubmissionId: null }, undefined, { allowUncertainTurn: true }]])
  const earlierId = submit.mock.calls[0]![2]
  await missingStorage()
  const head = entry('manual-head'), tail = entry('automatic-tail')
  await act(async () => {
    useAppStore.setState({ agentSteerQueues: { [session.id]: [head, tail] }, agentComposerDrafts: { [session.id]: 'Retained later draft' } })
    await useAppStore.getState().flushAgentSteerQueue(session.id)
  })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
    { ...head, status: 'deferred', error: expect.stringContaining('Saving the workbench is unconfirmed') }, tail
  ])
  await clickText('Outbox')
  await clickText('Send queued message')
  expect(submit.mock.calls).toEqual([
    [session.control, 'Earlier accepted message', earlierId, { expectedRun: session.control.run, afterSubmissionId: null }, undefined, { allowUncertainTurn: true }],
    [session.control, head.text, head.operationId, head.promptCondition, undefined, { allowUncertainTurn: true }]
  ])
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([tail])
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Retained later draft')
  expect(useAppStore.getState().tabs).toEqual({ [tab.id]: tab })
  expect(useAppStore.getState().sessions).toEqual([session])
  expect(container.textContent).toContain('Saving the workbench is unconfirmed')
  await useAppStore.getState().sendQueuedAgentSteer(session.id, head.operationId)
  expect(submit).toHaveBeenCalledTimes(2)
})

it('an already bound restoring message has the same explicit grant at both save boundaries', async () => {
  await missingStorage()
  const bound = entry('bound-restoring', { status: 'restoring' })
  useAppStore.setState({ agentSteerQueues: { [session.id]: [bound] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, bound.operationId)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls).toEqual([
    [session.control, bound.text, bound.operationId, bound.promptCondition, undefined, { allowUncertainTurn: true }]
  ])
  expect(useAppStore.getState().agentSteerQueues[session.id]).toBeUndefined()
  expect(useAppStore.getState().workbenchSaveWarning).toContain('Saving the workbench is unconfirmed')
})

it('a newly recovered binding does not inherit the already-bound save bypass', async () => {
  await missingStorage()
  const unbound = entry('unbound', { runId: undefined, status: 'restoring' })
  useAppStore.setState({ agentSteerQueues: { [session.id]: [unbound] } })
  const recover = vi.spyOn(useAppStore.getState(), 'recoverSession').mockResolvedValue(session)
  await useAppStore.getState().sendQueuedAgentSteer(session.id, unbound.operationId)
  expect(recover).toHaveBeenCalledTimes(1)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
    { ...unbound, runId: session.control.run.runId, error: expect.stringContaining('Saving the workbench is unconfirmed') }
  ])
})

it('an unresolved host save cannot hold the bound explicit dispatch open', async () => {
  let releaseHost!: () => void
  const pendingHost = new Promise<void>(resolve => { releaseHost = resolve })
  const save = vi.spyOn(api.ui, 'requestStorageFlush').mockReturnValue(pendingHost)
  const bound = entry('pending-host')
  useAppStore.setState({ agentSteerQueues: { [session.id]: [bound] } })
  const dispatched = useAppStore.getState().sendQueuedAgentSteer(session.id, bound.operationId)
  try {
    await vi.waitFor(() => expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1), { timeout: 200 })
    await dispatched
    expect(save).toHaveBeenCalled()
    expect(vi.mocked(api.sessions.submitPrompt).mock.calls).toEqual([
      [session.control, bound.text, bound.operationId, bound.promptCondition, undefined, { allowUncertainTurn: true }]
    ])
    expect(useAppStore.getState().agentSteerInFlight).toEqual({})
  } finally { releaseHost(); await dispatched }
})

it('unconfirmed storage and synchronous writer failure remain advisory but visible for explicit dispatch', async () => {
  const unconfirmed = await observeWorkbenchStorageAuthority({ getStoragePath: () => null }, { userData: temporary, sessionData: temporary })
  expect(unconfirmed.localStorage).toBe('unconfirmed')
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => requireWorkbenchStorageAuthority(unconfirmed))
  const first = entry('unconfirmed')
  useAppStore.setState({ agentSteerQueues: { [session.id]: [first] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, first.operationId)
  expect(useAppStore.getState().workbenchSaveWarning).toContain('Saving the workbench is unconfirmed')
  const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Private writer refused') })
  const second = entry('writer-error')
  useAppStore.setState({ agentSteerQueues: { [session.id]: [second] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, second.operationId)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls).toEqual([
    [session.control, first.text, first.operationId, first.promptCondition, undefined, { allowUncertainTurn: true }],
    [session.control, second.text, second.operationId, second.promptCondition, undefined, { allowUncertainTurn: true }]
  ])
  expect(useAppStore.getState().workbenchSaveWarning).toBe('Private writer refused')
  setItem.mockRestore()
})

it('input uncertainty remains the original deferred message and does not swallow the separate save warning', async () => {
  await missingStorage()
  const pending = entry('input-unknown')
  vi.mocked(api.sessions.submitPrompt).mockRejectedValue(new Error('Original Input delivery unknown'))
  useAppStore.setState({ agentSteerQueues: { [session.id]: [pending] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, pending.operationId)
  expect(vi.mocked(api.sessions.submitPrompt).mock.calls).toEqual([
    [session.control, pending.text, pending.operationId, pending.promptCondition, undefined, { allowUncertainTurn: true }]
  ])
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
    { ...pending, status: 'deferred', error: 'Original Input delivery unknown' }
  ])
  expect(useAppStore.getState().workbenchSaveWarning).toContain('Saving the workbench is unconfirmed')
  await useAppStore.getState().flushAgentSteerQueue(session.id)
  expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1)
})

it('does not bypass an unknown original condition, a wrong Run or pending interaction', async () => {
  await missingStorage()
  const unknown = entry('unknown', { promptCondition: undefined })
  useAppStore.setState({ agentSteerQueues: { [session.id]: [unknown] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, unknown.operationId)
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([
    { ...unknown, status: 'deferred', error: expect.stringContaining('original message delivery condition is unknown') }
  ])
  const wrong = entry('wrong', { runId: 'old-run' })
  useAppStore.setState({ agentSteerQueues: { [session.id]: [wrong] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, wrong.operationId)
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([wrong])
  const interaction = entry('interaction')
  useAppStore.setState({ sessions: [{ ...session, pendingInteraction: { request: { id: 'private-question' } } } as never], agentSteerQueues: { [session.id]: [interaction] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, interaction.operationId)
  expect(useAppStore.getState().agentSteerQueues[session.id]).toEqual([interaction])
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})

it('retains hydration references and strict quit saving rather than claiming new renderer durability', async () => {
  // The last actual saved record survives; subsequent save refusal does not certify newer bytes.
  useAppStore.setState({ agentComposerDrafts: { [session.id]: 'Unconfirmed newer draft' } })
  await missingStorage()
  await expect(prepareRendererUpdate('quit')).rejects.toThrow('Saving the workbench is unconfirmed')
  const saved = localStorage.getItem('agentmux-workbench-v1')
  expect(saved).not.toBeNull()
  useAppStore.setState({ tabs: {}, layouts: {}, sessions: [], restoredWorkbench: null, agentComposerDrafts: {} })
  localStorage.setItem('agentmux-workbench-v1', saved!)
  await useAppStore.persist.rehydrate()
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  const restarted = await useAppStore.getState().initialize()
  try {
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ [session.id]: 'Unconfirmed newer draft' })
    expect(useAppStore.getState().sessions).toEqual([session])
    expect(useAppStore.getState().tabs).toEqual({ [tab.id]: tab })
  } finally { restarted() }
})
