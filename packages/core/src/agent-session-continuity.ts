import type {
  AgentCapabilitySnapshot,
  AgentCatalogEntry,
  AgentMuxAgentSession,
  AgentMuxRun,
  AgentMuxRunRef,
  AgentNativeSessionHandle
} from './types.js'

export type AgentMuxAgentContinuityInput = {
  agentSessionId: string
  expectedRun: AgentMuxRunRef
  operationId: string
  args?: readonly string[]
  env?: Readonly<Record<string, string>>
  commandOverride?: string
  cols?: number
  rows?: number
}

export type AgentMuxAgentContinuityUnavailableReason =
  | 'unknown-session'
  | 'native-handle-unavailable'
  | 'provider-resume-unsupported'
  | 'provider-unavailable'

/**
 * 恢复被「占着」的两类。**它们要求用户做的事相反**，所以必须是两个取值而不是一个 conflict 位。
 *
 * - `session-run-changed`：这条 Agent Session **还活着，但已经在一个更新的 Run 上**（别处已经
 *   resume 过它）。于是「等一下」是错建议——被替换掉的 Run 等多久都不会回来；正确的动作是重读
 *   这条 session 的当前快照（按稳定的 agentSessionId 取，不按 run 取）。
 * - `lifecycle-busy`：另一个生命周期操作**此刻**正持有它，这是短暂的。这一类「等」才对。
 *
 * 抽成一个命名类型而不是继续内联：desktop 侧要按它分流出两套文案与两个动作，而内联的字面量
 * 会让两边各写一遍取值域——那是必然 drift 的两处常量。
 */
export type AgentMuxAgentContinuityConflictReason =
  | 'session-run-changed'
  | 'lifecycle-busy'

export type AgentMuxAgentContinuityRunEvidence =
  | { kind: 'run-running'; observedAt: number }
  | { kind: 'run-ended'; state: 'exited' | 'interrupted'; observedAt: number }
  | { kind: 'run-missing'; observedAt: number }

export type AgentMuxAgentContinuityResult =
  | {
      kind: 'reattachable'
      session: AgentMuxAgentSession
      previousRun: AgentMuxRunRef
      run: AgentMuxRun
      evidence: Extract<AgentMuxAgentContinuityRunEvidence, { kind: 'run-running' }>
    }
  | {
      kind: 'resumed'
      session: AgentMuxAgentSession
      previousRun: AgentMuxRunRef
      run: AgentMuxRunRef
      evidence: {
        kind: 'provider-native'
        providerId: string
        nativeSessionId: string
        previousRun: AgentMuxAgentContinuityRunEvidence
      }
    }
  | {
      kind: 'unavailable'
      agentSessionId: string
      previousRun: AgentMuxRunRef
      reason: AgentMuxAgentContinuityUnavailableReason
      evidence: AgentMuxAgentContinuityRunEvidence | { kind: 'unknown-session' }
    }
  | {
      kind: 'retired'
      agentSessionId: string
      previousRun: AgentMuxRunRef
      evidence: { kind: 'user-retired'; observedAt: number }
    }
  | {
      kind: 'conflict'
      agentSessionId: string
      previousRun: AgentMuxRunRef
      currentRun?: AgentMuxRunRef
      reason: AgentMuxAgentContinuityConflictReason
      evidence: { kind: 'agent-session-store' } | { kind: 'hook-ingress-owner' }
    }

export type AgentMuxAgentContinuityFacts = {
  agentSessionId: string
  hostId: string
  expectedRun: AgentMuxRunRef
  observedAt: number
  session: AgentMuxAgentSession | null
  retirement: {
    agentSessionId: string
    hostId: string
    run: AgentMuxRunRef
    source: 'user'
    observedAt: number
  } | null
  run: AgentMuxRun | null
  catalog: AgentCatalogEntry | null
  capability: AgentCapabilitySnapshot | null
}

export type AgentMuxAgentContinuityDecision =
  | Exclude<AgentMuxAgentContinuityResult, { kind: 'resumed' }>
  | {
      kind: 'resume'
      session: AgentMuxAgentSession
      previousRun: AgentMuxRunRef
      nativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }>
      evidence: AgentMuxAgentContinuityRunEvidence
    }

function runEvidence(run: AgentMuxRun | null, observedAt: number): AgentMuxAgentContinuityRunEvidence {
  if (!run) return { kind: 'run-missing', observedAt }
  if (run.state === 'running') return { kind: 'run-running', observedAt: run.observedAt }
  return { kind: 'run-ended', state: run.state, observedAt: run.observedAt }
}

/**
 * Maps persisted Semantic Session truth and authoritative Run facts to one
 * continuity action. It does not inspect terminal bytes or execute a Run.
 */
export function decideAgentSessionContinuity(
  facts: AgentMuxAgentContinuityFacts
): AgentMuxAgentContinuityDecision {
  const previousRun = { ...facts.expectedRun }
  const session = facts.session
  if (!session) {
    if (
      facts.retirement?.agentSessionId === facts.agentSessionId &&
      facts.retirement.hostId === facts.hostId &&
      facts.retirement.run.runId === facts.expectedRun.runId
    ) {
      return {
        kind: 'retired',
        agentSessionId: facts.agentSessionId,
        previousRun,
        evidence: { kind: 'user-retired', observedAt: facts.retirement.observedAt }
      }
    }
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'unknown-session',
      evidence: { kind: 'unknown-session' }
    }
  }
  if (
    session.agentSessionId !== facts.agentSessionId ||
    session.run.runId !== facts.expectedRun.runId
  ) {
    return {
      kind: 'conflict',
      agentSessionId: facts.agentSessionId,
      previousRun,
      currentRun: { ...session.run },
      reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }
    }
  }
  if (
    facts.run &&
    (
      facts.run.runId !== session.run.runId ||
      facts.run.kind !== 'agent' ||
      facts.run.agentSessionId !== session.agentSessionId ||
      facts.run.providerId !== session.providerId ||
      facts.run.executorId !== session.executorId ||
      facts.run.workspacePath !== session.workspacePath
    )
  ) {
    return {
      kind: 'conflict',
      agentSessionId: facts.agentSessionId,
      previousRun,
      currentRun: { ...facts.run },
      reason: 'session-run-changed',
      evidence: { kind: 'agent-session-store' }
    }
  }

  const evidence = runEvidence(facts.run, facts.observedAt)
  if (facts.run?.state === 'running') {
    return {
      kind: 'reattachable',
      session: structuredClone(session),
      previousRun,
      run: structuredClone(facts.run),
      evidence: { kind: 'run-running', observedAt: facts.run.observedAt }
    }
  }

  if (
    !facts.catalog ||
    facts.catalog.id !== session.providerId ||
    facts.catalog.resumeStrategy.kind !== 'provider-native'
  ) {
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'provider-resume-unsupported',
      evidence
    }
  }
  const handle = session.nativeHandle
  if (
    !handle ||
    handle.kind !== 'provider' ||
    handle.providerId !== session.providerId ||
    (facts.catalog.resumeStrategy.locator === 'transcript-path' && !handle.transcriptPath)
  ) {
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'native-handle-unavailable',
      evidence
    }
  }
  if (
    !facts.capability?.installed ||
    facts.capability.providerId !== session.providerId ||
    !facts.capability.capabilities.providerResume
  ) {
    return {
      kind: 'unavailable',
      agentSessionId: facts.agentSessionId,
      previousRun,
      reason: 'provider-unavailable',
      evidence
    }
  }
  return {
    kind: 'resume',
    session: structuredClone(session),
    previousRun,
    nativeHandle: structuredClone(handle),
    evidence
  }
}
