// @vitest-environment happy-dom
import '../src/preload/index'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentMuxDesktopApi, AgentMuxPreloadApi, SessionInputWriteResult } from '../src/shared/contracts'
import type { AgentInputSubmissionReceipt } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), raw: null as AgentMuxPreloadApi | null }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, value: AgentMuxPreloadApi) => {
    bridge.raw = value
    Object.assign(window, { [name]: value })
  } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }
}))

const control = { kind: 'agent' as const, hostId: 'private-host', agentSessionId: 'private-session', run: { runId: 'original-run' } }
const invocations = [
  { method: 'write' as const, channel: 'sessions:write', args: [control, 'raw input', 'user'] satisfies Parameters<AgentMuxDesktopApi['sessions']['write']> },
  { method: 'paste' as const, channel: 'sessions:paste', args: [control, 'plain text', '\u001b[200~plain text\u001b[201~'] satisfies Parameters<AgentMuxDesktopApi['sessions']['paste']> },
  { method: 'submitPrompt' as const, channel: 'sessions:submitPrompt', args: [control, 'original prompt', 'original-op',
    { expectedRun: { runId: 'original-run' }, afterSubmissionId: null }, { allowUncertainTurn: true, execution: 'immediate' }, true, 'note', 'message-tool'] satisfies Parameters<AgentMuxDesktopApi['sessions']['submitPrompt']> }
]
const failures: SessionInputWriteResult[] = [
  { ok: false, error: { code: 'PRIVATE_READONLY_REFUSAL', message: 'Preparation refused this call', detail: 'original structured cause',
    controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } } },
  { ok: false, error: { code: 'PRIVATE_UNKNOWN_INPUT', message: 'Original operation remains unknown', detail: 'original unknown cause',
    controlFailure: { disposition: 'unknown', confirmedInputBytes: 3 } } }
]

beforeEach(() => bridge.invoke.mockReset())
function expectInvocation(channel: string, args: readonly unknown[]) {
  expect(bridge.invoke.mock.calls).toHaveLength(1)
  const actual = bridge.invoke.mock.calls[0]!, expected = [channel, ...args]
  expect(actual.slice(0, expected.length)).toEqual(expected)
  // Omitted optional arguments may cross contextBridge as explicit undefined;
  // every caller-supplied value must retain its exact original position.
  expect(actual.slice(expected.length)).toEqual(Array(Math.max(0, actual.length - expected.length)).fill(undefined))
}
for (const invocation of invocations) {
  for (const failure of failures) {
    it(`${invocation.method} copies ${!failure.ok && failure.error.code} through the raw preload before Renderer restores the error`, async () => {
      bridge.invoke.mockImplementation(async () => structuredClone(failure))
      const raw = await (bridge.raw!.sessions[invocation.method] as (...args: unknown[]) => Promise<SessionInputWriteResult>)(...invocation.args)
      expect(raw).toEqual(failure)
      expectInvocation(invocation.channel, invocation.args)
      bridge.invoke.mockClear()
      const result = (api.sessions[invocation.method] as (...args: unknown[]) => Promise<void>)(...invocation.args)
      expect(failure.ok).toBe(false)
      if (failure.ok) throw new Error('Nonempty error case required')
      await expect(result).rejects.toMatchObject(failure.error)
      expectInvocation(invocation.channel, invocation.args)
    })
  }
  it(`${invocation.method} resolves successful input to the original void Desktop contract`, async () => {
    bridge.invoke.mockResolvedValue({ ok: true })
    await expect((api.sessions[invocation.method] as (...args: unknown[]) => Promise<void>)(...invocation.args)).resolves.toBeUndefined()
    expectInvocation(invocation.channel, invocation.args)
  })
}

it('preserves conversation intent and the original waiting key through preload and Renderer receipt decoding', async () => {
  const key = { kind: 'prompt' as const, agentSessionId: control.agentSessionId, expectedRun: control.run, submissionId: 'original-semantic-task' }
  const ref = { key, waitGeneration: 1 }
  const receipt: AgentInputSubmissionReceipt = { key, ref, persistence: 'confirmed', status: 'waiting', observation: 'rejoin-needed', admission: null,
    control: { ref, state: 'enabled', at: 1, waiting: { phase: 'session', reason: 'native-session-starting', wake: 'session-restored' } } }
  const args: Parameters<AgentMuxDesktopApi['sessions']['submitPrompt']> = [control, 'Original task', key.submissionId,
    { expectedRun: control.run, admissionIntent: { kind: 'session-conversation' } }, { execution: 'immediate' }, true]
  bridge.invoke.mockImplementation(async () => structuredClone({ ok: true, inputReceipt: receipt }))
  await expect(api.sessions.submitPrompt(...args)).resolves.toEqual(receipt)
  expectInvocation('sessions:submitPrompt', args)
})
