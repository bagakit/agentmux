import { createHash } from 'node:crypto'
import { hashAgentCapability } from './agent-capability.js'
import { hookBindingIdentity } from './agent-session-identity.js'
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
