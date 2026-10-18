import { api } from '../../../src/renderer/src/lib/api'
import { TerminalInitialObservationRecovery } from '../../../src/renderer/src/lib/terminal-initial-observation-recovery'
import type { AgentSessionControl, SessionControl } from '../../../src/shared/contracts'

const scoped = { hostId: 'local', agentSessionId: 'private-agent' }
const control: AgentSessionControl = { kind: 'agent', ...scoped, run: { runId: 'original-run' } }
const query = { ...scoped, operationId: 'original-landmark' }
const write = { ...query, expectedRevision: 0, change: { kind: 'remove' as const, id: 'original-point' } }
const continuity = { agentSessionId: 'private-agent', intentOperationId: 'original-intent', expectedRun: control.run,
  operationId: 'original-control', action: 'cancel' as const }
const calls = [() => api.landmarks.list(query), () => api.landmarks.apply(write), () => api.sessions.attach(control),
  () => api.sessions.refreshAttachment(control, null, 0), () => api.sessions.replay('original-lease', 0),
  () => api.sessions.restart(control, 'original-operation', true), () => api.sessions.controlContinuity('local', continuity)]
const errorData = async (call: () => Promise<unknown>) => {
  try { return { returned: await call(), code: null, message: null } }
  catch (error) { const value = error as Error & { code?: string; detail?: string }; return { code: value.code ?? null, message: value.message, detail: value.detail ?? null } }
}
let recovery: TerminalInitialObservationRecovery | undefined, result: unknown, pending = false
let failures: Array<{ code: string | null }> = []
Object.assign(window, { bridgeProof: {
  async everyMethod() { return await Promise.all(calls.map(errorData)) },
  async restart() { return await errorData(calls[5]!) },
  async observe(target: SessionControl) {
    recovery?.dispose(); result = undefined; failures = []
    const attempt = async (refresh: boolean) => {
      pending = true
      try {
        result = refresh ? await api.sessions.refreshAttachment(target, null, 0) : await api.sessions.attach(target, 0)
        recovery!.acquired()
      } catch (error) {
        failures.push({ code: (error as { code?: string }).code ?? null })
        recovery!.failure(error)
      } finally { pending = false; recovery!.settled() }
    }
    recovery = new TerminalInitialObservationRecovery(true, () => !pending && result === undefined, () => attempt(true))
    await attempt(false)
  },
  read() { return { result, pending, failures } },
  dispose() { recovery?.dispose() }
} })
