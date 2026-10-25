import { expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { AgentMuxRun } from '../../../packages/core/src/types.js'
const old = { kind: 'terminal' as const, hostId: 'local', runId: 'old-run', run: { runId: 'old-run' } }
const run: AgentMuxRun = { runId: 'canonical-replacement', kind: 'terminal', state: 'running', providerId: null, executorId: null, agentSessionId: null,
  workspacePath: '/private/original', pid: 42, cols: 80, rows: 24, observedAt: 1, latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null }
it('[terminal recovery] actual Desktop recovery passes the original control and caller operation to Core and projects the canonical Run', async () => {
  const recoverTerminal = vi.fn(async () => ({ kind: 'recovered', expectedRun: old.run, runtimeId: 'runtime', operationId: 'canonical-op', run }))
  const createTerminal = vi.fn(async () => { throw Error('Desktop must not issue another creation') })
  const client = { recoverTerminal, createTerminal, terminalCreationRuntimeIdentity: () => ({ runtimeId: 'runtime' }) }
  const controller = Object.create(RuntimeController.prototype) as any
  controller.connectedClient = vi.fn(async () => client)
  controller.sessionByTarget = vi.fn(async (_client, target, _config, observed) => ({ id: target.runId, kind: 'terminal', workspacePath: observed.workspacePath,
    control: { ...old, runId: observed.runId, run: { runId: observed.runId } } }))
  const outcome = await controller.performRecovery(old, {}, run.workspacePath, 'remounted-op', { trigger: 'startup' }).then((value: unknown) => ({ value }), (error: unknown) => ({ error }))
  expect(outcome.error).toBeUndefined()
  const result = outcome.value
  expect(result).toMatchObject({ kind: 'terminal-restarted', session: { control: { runId: run.runId } } })
  expect(recoverTerminal).toHaveBeenCalledWith({ expectedRun: old.run, runtimeId: 'runtime', workspacePath: run.workspacePath, operationId: 'remounted-op', action: 'recover' })
  expect(createTerminal).not.toHaveBeenCalled()
  recoverTerminal.mockResolvedValueOnce({ kind: 'pending', operationId: 'canonical-op', expectedRun: old.run, runtimeId: 'runtime', phase: 'dispatched', message: 'Unknown Start' } as never)
  expect(await controller.performRecovery(old, {}, run.workspacePath, 'manual-op', { trigger: 'manual' })).toMatchObject({ kind: 'terminal-pending', recovery: { operationId: 'canonical-op' } })
  expect(recoverTerminal.mock.calls[1]![0]).toMatchObject({ operationId: 'manual-op', action: 'continue' })
})
