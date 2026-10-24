// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { connectAgentMuxRpc } from '@agentmux/core'
import type { AgentMuxContinuityOperation } from '@agentmux/core'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { readSessionRecoveryReply, sessionRecoveryReplyUnconfirmed } from '../src/shared/session-recovery-result'
import { createRendererSessionRecovery } from '../src/renderer/src/lib/session-recovery-api'
import { sessionRecoveryOperationResult } from '../src/main/session-recovery-operation'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-runtime-output /> }))
const dom = composerDOM(), id = 'original-recovery-session', operationId = 'original-recovery-operation'
const lost = sessionRecoveryReplyUnconfirmed(new Error('Private IPC reply lost'))
const original = { ...composerSession(id), terminalFrontend: { run: composerSession(id).control.run,
  frontendId: 'original-failed-front', state: 'detached' as const, backendState: 'running' as const,
  source: 'managed-process' as const, observedAt: 1, exitCode: 1 } }
const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', workspaceId: 'workspace', kind: 'agent', phase: 'attached', sessionId: id })
const receipt: AgentMuxContinuityOperation = { operationId, agentSessionId: id, previousRun: original.control.run, trigger: 'manual',
  policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, kind: 'pending', reason: 'operation-unconfirmed', admittedAt: 1, observedAt: 2, rechecks: 1,
  evidence: { kind: 'run-running', observedAt: 2 }, error: 'The original native conversation is unconfirmed.', errorCode: 'AGENT_TERMINAL_FRONTEND_UNCONFIRMED' }
const pending = () => ({ kind: 'pending' as const, agentSessionId: id, previousRun: original.control.run, reason: 'operation-unconfirmed' as const,
  evidence: { kind: 'run-running' as const, observedAt: 2 }, continuity: receipt })
const { exitCode: _originalExitCode, ...noExitFrontend } = original.terminalFrontend
const restored = () => ({ ...original, terminalFrontend: { ...noExitFrontend, frontendId: 'restored-front', state: 'attached' as const } })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function kept() {
  const state = useAppStore.getState()
  expect(state.tabs[tab.id]).toEqual(tab)
  expect(state.agentComposerDrafts[id]).toBe('Keep the original unsent draft 中')
  expect(state.sessions[0]!.id).toBe(id)
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
  expect(api.sessions.refresh).not.toHaveBeenCalled()
}
function exactReentry() {
  const calls = vi.mocked(api.sessions.recover).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
  expect(calls[0]).toEqual([original.control, original.workspacePath, operationId, { trigger: 'manual' }])
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api.connections, 'call').mockImplementation(async method => { if (method === 'connection.binding.ls') return { bindings: [] } as never; throw new Error('Unexpected connection operation') })
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: original.workspacePath })
  vi.spyOn(api.sessions, 'recover')
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(restored())
  vi.spyOn(api.sessions, 'stop'); vi.spyOn(api.sessions, 'launchAgent'); vi.spyOn(api.sessions, 'submitPrompt')
  useAppStore.setState({ config: composerConfig, loading: false, sessions: [original], tabs: { [tab.id]: tab },
    layouts: { workspace: { root: { type: 'leaf', groupId: 'group' }, groups: [{ id: 'group', tabOrder: [tab.id], activeTabId: tab.id, recentTabIds: [tab.id] }], activeGroupId: 'group' } },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench', viewModes: { [id]: 'terminal' }, agentComposerDrafts: { [id]: 'Keep the original unsent draft 中' },
    agentSteerQueues: {}, agentSteerInFlight: {}, recoveryCandidates: [], pendingAgentLaunches: {}, timelines: {}, notificationEvents: [] })
})

it('[terminal recovery] late raw Terminal recovery preserves the canonical Core Run after its view disappears', async () => {
  const raw = { ...original, kind: 'terminal' as const, id: 'old-raw-run', control: { kind: 'terminal' as const, hostId: 'local', runId: 'old-raw-run', run: { runId: 'old-raw-run' } } }
  const rawTab = createWorkbenchTab('raw-tab', { regionId: 'raw-region', workspaceId: 'workspace', kind: 'terminal', phase: 'attached', sessionId: raw.id })
  useAppStore.setState({ sessions: [raw as never], tabs: { [rawTab.id]: rawTab } })
  let complete!: (value: any) => void
  vi.mocked(api.sessions.recover).mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const job = useAppStore.getState().recoverSession(raw.id, 'original-raw-recovery')
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
  useAppStore.setState({ tabs: {} })
  complete({ kind: 'terminal-restarted', session: { ...raw, id: 'replacement-run', control: { ...raw.control, runId: 'replacement-run', run: { runId: 'replacement-run' } } } })
  await job
  expect(api.sessions.stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs).toEqual({})
})

it('[terminal recovery] actual Pane automatic daemon-restart recovery and remount use startup observation without continuation authority', async () => {
  const raw = { ...original, kind: 'terminal' as const, id: 'interrupted-raw-run', processState: 'interrupted' as const, interruptionReason: 'daemon_restart',
    control: { kind: 'terminal' as const, hostId: 'local', runId: 'interrupted-raw-run', run: { runId: 'interrupted-raw-run' } } }
  const rawTab = createWorkbenchTab('original-tab', { regionId: 'original-region', workspaceId: 'workspace', kind: 'terminal', phase: 'attached', sessionId: raw.id })
  useAppStore.setState({ sessions: [raw as never], tabs: { [rawTab.id]: rawTab } })
  vi.mocked(api.sessions.recover).mockResolvedValue({ kind: 'terminal-pending', recovery: { kind: 'pending', expectedRun: raw.control.run, runtimeId: 'runtime',
    operationId: 'canonical-raw-operation', phase: 'dispatched', message: 'Original Start unconfirmed' } })
  await dom.render(<WorkspaceWorkbench key="first" workspaceId="workspace" />)
  await vi.waitFor(() => expect(api.sessions.recover).toHaveBeenCalledOnce())
  await dom.render(<WorkspaceWorkbench key="remount" workspaceId="workspace" />)
  await vi.waitFor(() => expect(api.sessions.recover).toHaveBeenCalledTimes(2))
  expect(vi.mocked(api.sessions.recover).mock.calls.every(call => call[3]?.trigger === 'startup')).toBe(true)
  expect(api.sessions.stop).not.toHaveBeenCalled()
})

it('recovery receipt: re-enters the same original Core operation and retains its pending outcome after IPC reply loss', async () => {
  vi.mocked(api.sessions.recover).mockRejectedValueOnce(lost).mockResolvedValueOnce(pending())
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  const textbox = dom.container.querySelector('[role="textbox"]')
  let result: unknown
  await act(async () => { result = await useAppStore.getState().recoverSession(id, operationId) })
  expect(result).toBeUndefined()
  expect(useAppStore.getState().sessions[0]).toMatchObject({ control: original.control, continuity: receipt })
  expect(dom.container.querySelector('.full-page-loading--failed')?.textContent).toContain('Terminal process exited')
  expect(dom.container.querySelector('[role="textbox"]')).toBe(textbox)
  exactReentry(); kept()
})

it('recovery receipt: uses only the original Core re-entry result to complete recovery after reply loss', async () => {
  vi.mocked(api.sessions.recover).mockRejectedValueOnce(lost).mockResolvedValueOnce({ kind: 'reattachable', session: restored() })
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  let result: unknown
  await act(async () => { result = await useAppStore.getState().recoverSession(id, operationId) })
  expect(result).toEqual(restored())
  expect(dom.container.querySelector('[data-runtime-output]')).not.toBeNull()
  expect(dom.container.querySelector('.full-page-loading--failed')).toBeNull()
  exactReentry(); kept()
})

it.each(['AGENT_PROMPT_OPERATION_CONFLICT', 'AGENT_CONTINUITY_EXECUTOR_CONFLICT', 'CONTROL_PERMISSION_DENIED', 'CONTROL_CONNECTION_FAILED', 'CONTROL_PROTOCOL_ERROR', 'SESSION_RECOVERY_REPLY_UNCONFIRMED'])('recovery receipt: preserves delivered owner refusal %s regardless of an old running snapshot', async code => {
  const refusal = Object.assign(new Error('Original owner refused this request'), { code })
  vi.mocked(api.sessions.recover).mockImplementation(createRendererSessionRecovery(async () => structuredClone(await sessionRecoveryOperationResult(async () => { throw refusal }))))
  await expect(useAppStore.getState().recoverSession(id, operationId)).rejects.toMatchObject({ code, message: refusal.message })
  expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  kept()
})

it('recovery receipt: does not infer transport provenance from a displayed failure message', async () => {
  const error = new Error('RPC connection failed; original response lost')
  vi.mocked(api.sessions.recover).mockRejectedValue(error)
  await expect(useAppStore.getState().recoverSession(id, operationId)).rejects.toBe(error)
  expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  kept()
})

it('recovery receipt: stops bounded reconciliation after a second lost reply without a third operation', async () => {
  vi.mocked(api.sessions.recover).mockRejectedValue(lost)
  await expect(useAppStore.getState().recoverSession(id, operationId)).rejects.toBe(lost)
  exactReentry(); kept()
})

it('recovery receipt: preserves a Core conflict discovered while reconciling the original operation', async () => {
  vi.mocked(api.sessions.recover).mockRejectedValueOnce(lost).mockResolvedValueOnce({ kind: 'conflict', agentSessionId: id,
    previousRun: original.control.run, currentRun: { runId: 'another-current-run' }, reason: 'session-run-changed', evidence: { kind: 'agent-session-store' } })
  await expect(useAppStore.getState().recoverSession(id, operationId)).resolves.toBeUndefined()
  expect(useAppStore.getState().sessions[0]!.control).toEqual(original.control)
  exactReentry(); kept()
})

it('recovery receipt: a real Core RPC lost reply survives the delivered Main IPC envelope and re-enters only the original operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amxr-')), path = join(directory, 'r.sock')
  const server = createServer(socket => socket.once('data', () => socket.destroy()))
  server.listen(path); await once(server, 'listening')
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }) })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanups.push(() => rpc.dispose())
  vi.mocked(api.sessions.recover).mockImplementationOnce(createRendererSessionRecovery(async () => structuredClone(await sessionRecoveryOperationResult(async () => {
    await rpc.call('agent.resume', { target: { kind: 'agent-session', agentSessionId: id }, text: '', operationId })
    throw new Error('The private transport must lose its response')
  })))).mockResolvedValueOnce(pending())
  await expect(useAppStore.getState().recoverSession(id, operationId)).resolves.toBeUndefined()
  expect(useAppStore.getState().sessions[0]).toMatchObject({ continuity: receipt })
  exactReentry(); kept()
})

it('recovery receipt: freezes the original input across reconciliation instead of reading a changed caller object', async () => {
  const input = { submissionId: 'original-input', prompt: 'Original body', authorHuman: true }
  vi.mocked(api.sessions.recover).mockImplementationOnce(async () => { input.prompt = 'Later caller edit'; throw lost }).mockResolvedValueOnce(pending())
  await expect(useAppStore.getState().recoverSession(id, operationId, { input, trigger: 'input' })).resolves.toBeUndefined()
  const calls = vi.mocked(api.sessions.recover).mock.calls
  expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]); expect(calls[1]![3]!.input!.prompt).toBe('Original body')
  kept()
})

it('recovery receipt: keeps a definitive Core refusal obtained during reconciliation', async () => {
  const refusal = Object.assign(new Error('The original frozen request conflicts'), { code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  vi.mocked(api.sessions.recover).mockRejectedValueOnce(lost).mockImplementationOnce(createRendererSessionRecovery(async () => structuredClone(await sessionRecoveryOperationResult(async () => { throw refusal }))))
  await expect(useAppStore.getState().recoverSession(id, operationId)).rejects.toMatchObject({ code: refusal.code })
  exactReentry(); kept()
})

it('recovery receipt: does not admit another observation after the caller cancels its pending intent', async () => {
  let current = true
  vi.mocked(api.sessions.recover).mockImplementationOnce(async () => { current = false; throw lost })
  await expect(useAppStore.getState().recoverSession(id, operationId, { stillCurrent: () => current })).resolves.toBeUndefined()
  expect(api.sessions.recover).toHaveBeenCalledTimes(1)
  kept()
})

it('initialization surface: shows the actual preflight failure, retained draft and usable recovery without inventing a terminal exit', async () => {
  useAppStore.setState({ sessions: [{ ...original, terminalFrontend: { ...noExitFrontend, state: 'starting',
    initialization: { lifecycleOperationId: 'original-start', phase: 'failed', native: { state: 'not-created' },
      failure: { step: 'preflight', code: -32603, message: 'Workspace routing discovery timed out' } } } }] })
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  expect(dom.container.querySelector('.full-page-loading--failed')?.textContent).toContain('Agent couldn’t finish starting')
  expect(dom.container.querySelector('.full-page-loading')?.textContent).toContain('Setup failed before a native conversation was created')
  expect(dom.container.textContent).toContain('Workspace routing discovery timed out')
  expect(dom.container.textContent).not.toContain('Terminal exit code')
  expect(dom.container.querySelector('[role="textbox"]')).not.toBeNull()
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Resume')).toBe(true)
  kept()
})

it('initialization surface: a creation with no reply remains unconfirmed and offers checking the original request', async () => {
  useAppStore.setState({ sessions: [{ ...original, terminalFrontend: { ...noExitFrontend, state: 'starting',
    initialization: { lifecycleOperationId: 'original-start', phase: 'unknown', native: { state: 'unknown' } } } }] })
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  expect(dom.container.querySelector('.full-page-loading')?.textContent).toContain('Startup result unconfirmed')
  expect(dom.container.querySelector('.full-page-loading--failed')).toBeNull()
  expect([...dom.container.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Check original request')).toBe(true)
  kept()
})

it('initialization surface: an unknown observation preserves an already attached terminal and existing Composer', async () => {
  useAppStore.setState({ sessions: [{ ...original, terminalFrontend: { ...noExitFrontend, state: 'attached',
    initialization: { lifecycleOperationId: 'original-start', phase: 'unknown', native: { state: 'unknown' } } } }] })
  await dom.render(<WorkspaceWorkbench workspaceId="workspace" />)
  expect(dom.container.querySelector('.full-page-loading')).toBeNull()
  expect(dom.container.querySelector('[data-runtime-output]')).not.toBeNull()
  expect(dom.container.querySelector('[role="textbox"]')).not.toBeNull()
  kept()
})
