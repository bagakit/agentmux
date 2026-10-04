import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '@agentmux/core'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import type { SessionSnapshot } from '../src/shared/contracts'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of dispose.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const request = { hostId: 'local', workspacePath: _hygiene_fixturePath("private-fixture-project"), createOperationId: 'the-original-operation', cols: 90, rows: 24 }
async function owner() {
  const f = await owningBridge(); dispose.push(f.dispose)
  const originalInvoke = bridge.invoke.getMockImplementation()!
  // Electron transports a thrown Error's message rather than its custom properties.
  bridge.invoke.mockImplementation(async (...args: unknown[]) => {
    try { return structuredClone(await originalInvoke(...args)) }
    catch (error) { throw new Error(error instanceof Error ? error.message : String(error)) }
  })
  return f
}

it.each(['unknown', 'not_applied'] as const)('real registered Main IPC and preload preserve original terminal creation %s facts', async disposition => {
  const f = await owner()
  const launch = vi.spyOn(f.runtime, 'launchTerminal').mockRejectedValue(new AgentMuxError('Native shell creation receipt unavailable.',
    'CTXMUX_IO', 'exact original failure', { disposition, confirmedInputBytes: null }))
  await expect(bridge.api!.sessions.launchTerminal(request)).rejects.toMatchObject({
    code: 'CTXMUX_IO', message: 'Native shell creation receipt unavailable.', detail: 'exact original failure',
    controlFailure: { disposition, confirmedInputBytes: null }
  })
  expect(launch).toHaveBeenCalledExactlyOnceWith(request, expect.any(Object))
})

it('plain transport failure stays unknown and successful confirmation returns the same session without internal envelope leakage', async () => {
  const f = await owner()
  const terminal: SessionSnapshot = { id: 'original-run', kind: 'terminal', providerId: null, hostId: 'local',
    workspacePath: request.workspacePath, label: 'Terminal', createdAt: 1, updatedAt: 1, latestOutputBytes: 0,
    processState: 'running', status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: 'original-run', run: { runId: 'original-run' } } }
  const launch = vi.spyOn(f.runtime, 'launchTerminal').mockRejectedValueOnce(new Error('Original response was lost.')).mockResolvedValue(terminal)
  await expect(bridge.api!.sessions.launchTerminal(request)).rejects.toMatchObject({
    code: 'TERMINAL_CREATE_UNCONFIRMED', controlFailure: { disposition: 'unknown', confirmedInputBytes: null }
  })
  await expect(bridge.api!.sessions.launchTerminal(request)).resolves.toEqual(terminal)
  expect(launch).toHaveBeenCalledTimes(2)
  expect(launch.mock.calls[0]![0]).toEqual(launch.mock.calls[1]![0])
})
