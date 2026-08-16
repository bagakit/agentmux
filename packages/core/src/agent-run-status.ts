import { classifyRunExit, type AgentMuxRunExitReason } from './agent-run-exit.js'
import type { AgentDisplayState, AgentMuxEvidenceSource, AgentMuxRunState } from './types.js'

/** Shared process projection for Core observations, desktop snapshots and live events.
 * Runtime owns process facts; this module only decides how to present them. It has no host imports.
 */
export type RunProcessStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
  exitReason?: AgentMuxRunExitReason
}

type RunExitFacts = {
  exitCode?: number
  exitSignal?: string
  exitReason?: AgentMuxRunExitReason
  interruptionReason?: string
}

export type RunProcessObservation = RunExitFacts & {
  state: AgentMuxRunState
  source: AgentMuxEvidenceSource
  observedAt: number
}

export const RUN_INTERRUPTED_DETAIL = 'The Run was interrupted; the cause was not reported.'

/** An interrupted Runtime is not evidence that the Agent crashed. A recorded user stop takes
 * precedence over its resulting signal/code. Unknown exits stay neutral, without claiming success.
 */
export function runDisplayState(observation: RunExitFacts & { state: AgentMuxRunState }): AgentDisplayState {
  if (observation.state === 'running') return 'running'
  const reason = observation.exitReason ?? classifyRunExit({
    stopRequested: false,
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    ...(observation.exitSignal === undefined ? {} : { exitSignal: observation.exitSignal })
  })
  if (reason === 'user-stopped') return 'exited'
  if (reason === 'crashed') return 'error'
  return observation.state === 'interrupted' ? 'disconnected' : 'exited'
}

/** Preserve optional facts in both projection paths; absence is not an empty or invented fact. */
export function runExitFacts(source: RunExitFacts): RunExitFacts {
  return {
    ...(source.exitCode === undefined ? {} : { exitCode: source.exitCode }),
    ...(source.exitSignal === undefined ? {} : { exitSignal: source.exitSignal }),
    ...(source.exitReason === undefined ? {} : { exitReason: source.exitReason }),
    ...(source.interruptionReason === undefined ? {} : { interruptionReason: source.interruptionReason })
  }
}

export function projectRunProcessStatus(observation: RunProcessObservation): RunProcessStatus {
  const interruptionDetail = observation.interruptionReason === 'daemon_restart'
    ? 'The Runtime restarted and interrupted this Run.'
    : observation.interruptionReason
      ? `The Run was interrupted (${observation.interruptionReason}).`
      : RUN_INTERRUPTED_DETAIL
  return {
    state: runDisplayState(observation),
    source: observation.source,
    observedAt: observation.observedAt,
    ...(observation.state === 'interrupted'
      ? { detail: interruptionDetail }
      : observation.exitSignal === undefined
        ? {}
        : { detail: `signal ${observation.exitSignal}` }),
    ...(observation.exitCode === undefined ? {} : { exitCode: observation.exitCode }),
    ...(observation.exitReason === undefined ? {} : { exitReason: observation.exitReason })
  }
}
