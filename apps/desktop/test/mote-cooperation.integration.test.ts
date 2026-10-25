// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
vi.mock('node:child_process', async original => { const actual = await original<typeof import('node:child_process')>(); return { ...actual,
  fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) => actual.fork(
    String(path).endsWith('/control-endpoint-listener-worker.js') ? fileURLToPath(new URL('../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork
} })
import { createMoteInputFixture, moteInputTestSource } from '../../../packages/core/test/helpers/mote-input-owner'
import { RuntimeController } from '../src/main/runtime-controller'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { moteAgent } from './fixtures/mote-workface'

const baseline = useAppStore.getState()
let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.(); close = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); useAppStore.setState(baseline, true) })
it('the original Desktop Store and Main submit reach real Host/Core RPC, then notify its original main Agent without inventing a terminal result', async () => {
  const f = await createMoteInputFixture(); close = f.close
  const originalSpatial = await f.spatial.read()
  vi.spyOn(f.client.providers.get('codex'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  const member = { ...moteAgent('member', null), providerId: 'codex', workspacePath: f.root,
    control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'member', run: { runId: 'run-member' } },
    nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'member-native', transcriptPath: f.transcript } }
  useAppStore.setState({ sessions: [member], agentSteerQueues: {}, agentSteerInFlight: {}, agentSteerInFlightPhase: {}, agentComposerDrafts: { member: 'Independent retained draft' } })
  // Only replace Host connection acquisition. Execute the real Main submit method and original SDK/RPC owners.
  const controller = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(controller, { configuredClient: () => f.hosted,
    trackHostOperation: async (_hostId: string, operation: () => Promise<unknown>) => await operation() })
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation((control, key) => controller.inspectInput(control, key))
  vi.spyOn(api.sessions, 'submitPrompt').mockImplementation((control, body, operationId, condition, choice, human, note, channel) =>
    controller.submitPrompt(control, body, operationId, condition, undefined, choice, human, note, channel))
  const rejected = vi.fn()
  expect(useAppStore.getState().send('member', 'Change the threshold to 12', rejected, 'manual', undefined, { moteSource: moteInputTestSource })).toBe(true)
  const entry = useAppStore.getState().agentSteerQueues.member![0]!
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(1), { timeout: 10000 })
  await vi.waitFor(async () => expect((await f.read(entry.operationId)).inspection?.observation.input).toBe('terminal-confirmed'))
  expect(rejected).not.toHaveBeenCalled()
  const terminalWrite = JSON.stringify(f.inner.kernel.input.mock.calls)
  expect(terminalWrite).toContain('Change the threshold to 12')
  expect(terminalWrite).toContain('amux mote --skill')
  expect(f.writes.filter(write => write.key?.agentSessionId === 'primary')).toHaveLength(0)
  f.idle(); await f.settle()
  await vi.waitFor(() => expect(f.writes.filter(write => write.key?.agentSessionId === 'primary')).toHaveLength(1))
  await f.settle()
  const observed = (await f.read(entry.operationId)).inspection!
  expect(observed.inputText).toBe('Change the threshold to 12')
  expect(observed.observation.binding?.primary.agentSessionId).toBe('primary')
  expect(observed.observation.origin).toMatchObject({ kind: 'prompt', key: f.key(entry.operationId) })
  expect(observed.notices.input?.state).toBe('submitted')
  expect(observed.observation.result).toBeUndefined() // PTY acknowledgement is not an adopted native result.
  expect(await f.spatial.read()).toEqual(originalSpatial)
  expect(useAppStore.getState().agentComposerDrafts.member).toBe('Independent retained draft')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.input).toHaveBeenCalledTimes(1)
}, 20000)
