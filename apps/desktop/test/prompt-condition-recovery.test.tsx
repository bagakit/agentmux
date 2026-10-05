// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composerDOM, composerSession, composerConfig } from './helpers/composer-dom-fixture'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { api } from '../src/renderer/src/lib/api'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import type { AgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxPreloadApi, DesktopControlResponse } from '../src/shared/contracts'
const dom = composerDOM(), sid = 'agent-1', runId = 'run-agent-1'
const original = (): AgentSteerQueueEntry => ({ operationId: 'old-condition', text: 'Original full body\n第二行正文', runId,
  promptCondition: { expectedRun: { runId }, afterSubmissionId: null }, status: 'deferred',
  errorCode: 'AGENT_PROMPT_CONDITION_CHANGED', error: 'Original exact condition refusal', logId: 'AbCdEfGhJkLm',
  agentMuxNote: 'Platform note must not become human text', sourceChannel: 'browser',
  awaitingExplicitSend: true, enqueuedAt: 1 })
const entry = () => useAppStore.getState().agentSteerQueues[sid]![0]!
const move = (text = original().text, expectedRun = runId) => useAppStore.getState().moveQueuedAgentSteerToDraft(sid, 'old-condition', text, expectedRun)
beforeEach(async () => {
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', join(process.cwd(), 'packages/core/bin/amux'))
  const dispose = await useAppStore.getState().initialize(); dispose()
  useAppStore.setState({ config: composerConfig, sessions: [composerSession()], agentSteerQueues: { [sid]: [original()] },
    agentComposerDrafts: { [sid]: '  Existing draft\n' }, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, timelines: {} })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  vi.spyOn(api.continuousProgress, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} })
})
it('atomically appends authored text and archives only the selected original, preserving full provenance and whitespace', async () => {
  const unrelated = { ...original(), operationId: 'unrelated', text: 'Other body' }
  useAppStore.setState({ agentSteerQueues: { [sid]: [original(), unrelated] } })
  const observations: Array<[boolean, string | undefined]> = []
  const off = useAppStore.subscribe(state => observations.push([Boolean(state.agentSteerQueues[sid]![0]!.archived), state.agentComposerDrafts[sid]]))
  try { await move() } finally { off() }
  const merged = '  Existing draft\n\n\n' + original().text
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(merged)
  expect(entry()).toEqual({ ...original(), archived: true, movedToDraft: true })
  expect(useAppStore.getState().agentSteerQueues[sid]![1]).toBe(unrelated)
  expect(observations.filter(([archived, draft]) => archived !== (draft === merged))).toEqual([])
  await move(); expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(merged)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
it.each(['text', 'run', 'in-flight', 'confirmed', 'missing-identity', 'archived-elsewhere'] as const)('refuses the %s action-time race without altering either original', async race => {
  if (race === 'archived-elsewhere') useAppStore.setState({ agentSteerQueues: { [sid]: [{ ...original(), archived: true }] } })
  if (race === 'run') useAppStore.setState({ sessions: [{ ...composerSession(), control: { ...composerSession().control, run: { runId: 'new-run' } } }] })
  if (race === 'in-flight') useAppStore.setState({ agentSteerInFlight: { [sid]: 'old-condition' } })
  if (race === 'confirmed') useAppStore.setState({ timelines: { [sid]: { agentSessionId: sid, revision: 1, items: [{ id: 'prompt:old-condition', agentSessionId: sid, kind: 'user_message', status: 'complete', source: 'user', content: original().text, createdAt: 1, updatedAt: 1 }] } } })
  if (race === 'missing-identity') useAppStore.setState({ agentSteerQueues: { [sid]: [{ ...original(), errorCode: 'AGENT_PROMPT_INPUT_UNCONFIRMED' }] } })
  const before = entry()
  await expect(move(race === 'text' ? 'Changed original text' : original().text)).rejects.toHaveProperty('code')
  expect(entry()).toBe(before); expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('  Existing draft\n')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
it('a save failure retains atomic state; retry saves only and cannot overwrite a later edit', async () => {
  vi.mocked(api.ui.requestStorageFlush).mockRejectedValueOnce(new Error('Exact storage failure'))
  await expect(move()).rejects.toThrow('Exact storage failure')
  expect(entry().archived).toBe(true)
  expect(useAppStore.getState().workbenchSaveWarning).toContain('Exact storage failure')
  useAppStore.getState().setAgentComposerDraft(sid, 'Later user edit')
  await move(); expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('Later user edit')
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
it('actual Composer pending action moves to its same live editor and removes obsolete send, without dispatch', async () => {
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const editor = dom.container.querySelector('[role="textbox"]')!
  const card = document.querySelector('.composer-pending__card')!
  expect(card.textContent).toContain('发送条件已变化')
  expect(card.querySelector('.composer-pending__send')).toBeNull()
  const button = [...card.querySelectorAll('button')].find(button => button.textContent === '移至草稿')!
  expect(button).toBeDefined()
  await act(async () => button.click())
  expect(entry()).toEqual({ ...original(), archived: true, movedToDraft: true })
  expect(dom.container.querySelector('[role="textbox"]')).toBe(editor)
  for (const line of original().text.split('\n')) expect(editor.textContent).toContain(line)
  expect(dom.draft()).toBe('  Existing draft\n\n\n' + original().text)
  expect(document.querySelector('.composer-pending__card')).toBeNull()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
it('keeps the known refusal through real Renderer control, RPC and compiled CLI; archive is exact and never recalls input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-condition-pending-'))
  let receive!: (request: AgentMuxControlRequest) => void
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: request => receive(request as AgentMuxControlRequest), sendCancellation() {} })
  const renderer = createRendererControlApi({ onRequest(listener) { receive = listener; return () => {} }, onCancellation() { return () => {} },
    respond(response: DesktopControlResponse) { bridge.accept(response) }
  } as AgentMuxPreloadApi['control'])
  const dispose = renderer.onRequest(request => useAppStore.getState().executeControl(request))
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), execute: request => bridge.execute(request) })
  try {
    await server.start()
    const cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(root))
    const sent = await cli(['message', 'pending', 'send', '--session', sid, '--pending-id', 'old-condition'])
    expect(sent.code).toBe(1); expect(JSON.parse(sent.stderr.split('\n').find(line => line.startsWith('{'))!).error).toMatchObject({ code: 'AGENT_PROMPT_CONDITION_CHANGED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    expect(entry()).toEqual(original())
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
    const list = await cli(['message', 'pending', 'ls', '--session', sid]); expect(list.code, list.stderr).toBe(0)
    expect(JSON.parse(list.stdout).result.messages[0]).toMatchObject({ text: original().text, errorCode: original().errorCode, delivery: 'unconfirmed', editable: false })
    const archived = await cli(['message', 'pending', 'archive', '--session', sid, '--pending-id', 'old-condition', '--expected-text', original().text])
    expect(archived.code, archived.stderr).toBe(0); expect(entry().archived).toBe(true)
    expect(entry().promptCondition).toEqual(original().promptCondition); expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('  Existing draft\n')
    expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  } finally { dispose(); bridge.dispose(); await server.stop(); await rm(root, { recursive: true }) }
})

it('a later explicit ordinary Send admits a new intent while the archived original remains intact', async () => {
  await move()
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue({ ...composerSession(), promptSubmissionPredecessor: 'later-admission' })
  await dom.render(<AgentSessionComposer sessionId={sid} />)
  const send = dom.container.querySelector<HTMLButtonElement>('.composer-send')
  expect(send).not.toBeNull()
  await act(async () => { send!.click(); await useAppStore.getState().flushAgentSteerQueue(sid) })
  await vi.waitFor(() => expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1))
  const call = vi.mocked(api.sessions.submitPrompt).mock.calls[0]!
  expect(call[1]).toBe('  Existing draft\n\n\n' + original().text)
  expect(call[2]).not.toBe('old-condition')
  expect(call[3]).toMatchObject({ expectedRun: { runId }, afterSubmissionId: 'later-admission' })
  expect(entry()).toEqual({ ...original(), archived: true, movedToDraft: true })
})
it('restoring a moved archive cannot append its body a second time', async () => {
  await move()
  const draft = useAppStore.getState().agentComposerDrafts[sid]
  await useAppStore.getState().archiveAgentSteer(sid, 'old-condition', original().text, false)
  await expect(move()).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(useAppStore.getState().agentComposerDrafts[sid]).toBe(draft)
})
it('the first nonempty draft retains the existing continuous-progress pause semantic', async () => {
  useAppStore.setState({ agentComposerDrafts: { [sid]: '' } })
  const pause = vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue()
  await move()
  expect(pause).toHaveBeenCalledExactlyOnceWith(composerSession().control)
  expect(dom.draft()).toBe(original().text)
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
})
