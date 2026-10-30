import { rpcRecord } from './rpc-data.js'
import { agentCreationIntentDigest } from './agent-creation-authority.js'
import type { AgentMuxAgentContinuityInput } from './agent-session-recovery/continuity-contract.js'
import { createHash } from 'node:crypto'
import { hookBindingIdentity, hashAgentCapability } from './agent-capability.js'
import { matchesProviderNativeSessionTarget } from './agent-native-locator.js'
import { decodePreparedRun, type PreparedRun } from './prepared-run.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxStoredAgentSession } from './types.js'

/** One private Agent binding check for durable freeze and positive legacy retained evidence. */
export function assertPreparedResumeBinding(prepared: PreparedRun, session: AgentMuxStoredAgentSession | undefined,
  operationId: string, code = 'INVALID_AGENT_SESSION_STORE'): void {
  const { request } = decodePreparedRun(prepared, code), env = request.env, continuity = session?.continuity
  const launch = continuity?.restartLaunch ?? continuity?.launchInput?.launchPlan
  if (!session || prepared.createOperationId !== operationId || request.cwd !== session.workspacePath ||
      !session.capabilityHash || !env.AGENTMUX_AGENT_CAPABILITY || hashAgentCapability(env.AGENTMUX_AGENT_CAPABILITY) !== session.capabilityHash ||
      !session.hookToken || env.AGENTMUX_HOOK_TOKEN !== session.hookToken || session.hookBindingId !== hookBindingIdentity(operationId) ||
      env.AGENTMUX_AGENT_SESSION_ID !== session.agentSessionId || env.AGENTMUX_PROVIDER_ID !== session.providerId || env.AGENTMUX_EXECUTOR_ID !== session.executorId ||
      !continuity || continuity.previousRun.runId !== session.run.runId || session.nativeHandle?.kind !== 'provider' ||
      !matchesProviderNativeSessionTarget(continuity.nativeTarget, session.nativeHandle) ||
      (launch && (launch.program !== request.program || launch.argsDigest !== createHash('sha256').update(JSON.stringify(request.args)).digest('base64url')))) {
    throw new AgentMuxError('The original Start does not match its prepared Agent binding. Its Run and original operation were preserved.', code)
  }
}

/** Private explicit request; never project execution environment through the safe receipt. */
export type ResumeResolutionRequest = Pick<AgentMuxAgentContinuityInput,
  'agentSessionId' | 'expectedRun' | 'operationId' | 'args' | 'env' | 'commandOverride' | 'cols' | 'rows'> & { trigger: 'manual' }
export function resumeResolutionRequest(input: AgentMuxAgentContinuityInput): ResumeResolutionRequest {
  if (input.trigger !== 'manual' || input.input !== undefined || input.timingOverride !== undefined) throw new AgentMuxError(
    'Continuing an unknown Start needs a new explicit manual request without input. The original request and inputs were kept.', 'AGENT_RESUME_RESOLUTION_REQUIRED')
  const value: Record<string, unknown> = { agentSessionId: input.agentSessionId, expectedRun: { ...input.expectedRun }, operationId: input.operationId, trigger: 'manual' }
  for (const field of ['args', 'env', 'commandOverride', 'cols', 'rows'] as const) if (input[field] !== undefined) value[field] = structuredClone(input[field])
  return parseResumeResolutionRequest(value)
}
export function parseResumeResolutionRequest(value: unknown): ResumeResolutionRequest {
  const code = 'INVALID_RESUME_RESOLUTION', r = rpcRecord(value, ['agentSessionId', 'expectedRun', 'operationId', 'trigger', 'args', 'env', 'commandOverride', 'cols', 'rows'], code)
  const run = rpcRecord(r.expectedRun, ['runId'], code), id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  const env = r.env === undefined ? undefined : rpcRecord(r.env, undefined, code)
  if (!id(r.agentSessionId) || !id(r.operationId) || !id(run.runId) || r.trigger !== 'manual' ||
      r.args !== undefined && (!Array.isArray(r.args) || r.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) ||
      env && Object.entries(env).some(([key, value]) => !key || /[=\0]/u.test(key) || typeof value !== 'string' || value.includes('\0')) ||
      r.commandOverride !== undefined && (typeof r.commandOverride !== 'string' || !r.commandOverride || r.commandOverride.includes('\0')) ||
      [r.cols, r.rows].some(size => size !== undefined && (!Number.isSafeInteger(size) || Number(size) < 1))) {
    throw new AgentMuxError('The manual resume resolution requires its exact Session, Run and unchanged execution intent.', code)
  }
  return structuredClone(r) as ResumeResolutionRequest
}
export function resumeResolutionDigest(request: ResumeResolutionRequest): string {
  return agentCreationIntentDigest({ ...request, action: 'resolve-prepared-resume' })
}
