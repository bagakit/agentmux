import { isAbsolute } from 'node:path'
import { AgentMuxError } from './errors.js'
import { parseAgentExecutionNotices } from './agent-execution-helper.js'
import { rpcRecord } from './rpc-data.js'
import { normalizeLaunchOptionSelection } from './agent-launch-option.js'
import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import { parseAgentCreationSpatialIntent } from './agent-session-store.js'
import { parseAgentMuxCreationAdmission } from './agent-creation-admission.js'
import type { AgentExecutionOpenInput, AgentExecutionInspection } from './agent-execution-coordinator.js'

export const AGENT_EXECUTION_CREATE_FIELDS = ['bindingId', 'agentHostId', 'agentRuntimeId', 'resourceHostId', 'resourceRuntimeId', 'resourceWorkspacePath', 'resourceGrant', 'agent'] as const
const agentFields = ['agentSessionId', 'createOperationId', 'executorId', 'executorRevision', 'workspacePath', 'prompt', 'agentMuxNote', 'agentMuxTask',
  'optionalContext', 'launchOptions', 'cols', 'rows', 'nativeResumeSource', 'spatialIntent', 'initialMessageAdmission', 'threadId'] as const
const invalid = (message: string, code: string): never => { throw new AgentMuxError(message, code) }
function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) invalid('An exact original execution identity is required.', code)
  return value as string
}
function text(value: unknown, code: string): void {
  if (typeof value !== 'string') invalid('Execution text must remain its original string.', code)
}
function workspace(value: unknown, code: string): string {
  const path = identity(value, code)
  if (!isAbsolute(path)) invalid('Execution workspaces must be exact absolute paths on their named Hosts.', code)
  return path
}

/** Wire structure only; original Host owners still validate configuration, grants and creation intent. */
export function parseAgentExecutionCreate(value: unknown): AgentExecutionOpenInput {
  const code = 'INVALID_CONTROL_REQUEST'
  const input = rpcRecord(value, AGENT_EXECUTION_CREATE_FIELDS, code)
  for (const field of ['bindingId', 'agentHostId', 'agentRuntimeId', 'resourceHostId', 'resourceRuntimeId']) identity(input[field], code)
  workspace(input.resourceWorkspacePath, code)
  const grant = rpcRecord(input.resourceGrant, ['scope', 'bindingId'], code)
  if (grant.scope !== 'host-user' || grant.bindingId !== input.bindingId) invalid('The explicit resource grant must name this original execution binding.', code)
  const agent = rpcRecord(input.agent, agentFields, code)
  for (const field of ['agentSessionId', 'createOperationId', 'executorId', 'executorRevision']) identity(agent[field], code)
  workspace(agent.workspacePath, code)
  for (const field of ['prompt', 'agentMuxNote', 'agentMuxTask']) if (agent[field] !== undefined) text(agent[field], code)
  if (agent.threadId !== undefined) identity(agent.threadId, code)
  for (const field of ['cols', 'rows']) if (agent[field] !== undefined && (!Number.isSafeInteger(agent[field]) || Number(agent[field]) <= 0)) invalid('Terminal dimensions must be positive safe integers.', code)
  if (agent.optionalContext !== undefined) {
    if (!Array.isArray(agent.optionalContext)) invalid('Optional context must be an ordered source array.', code)
    for (const source of agent.optionalContext as unknown[]) {
      const context = rpcRecord(source, ['text', 'omittedText'], code)
      text(context.text, code); text(context.omittedText, code)
    }
  }
  if (agent.launchOptions !== undefined) { rpcRecord(agent.launchOptions); normalizeLaunchOptionSelection(agent.launchOptions) }
  if (agent.nativeResumeSource !== undefined) parseAgentNativeResumeSource(agent.nativeResumeSource)
  if (agent.spatialIntent !== undefined) parseAgentCreationSpatialIntent(agent.spatialIntent)
  if (agent.initialMessageAdmission !== undefined) parseAgentMuxCreationAdmission(agent.initialMessageAdmission)
  // Keep exact original authored input, including empty text/options; these bytes
  // participate in the target Core's existing durable creation intent digest.
  return structuredClone(input) as unknown as AgentExecutionOpenInput
}

export function parseAgentExecutionBinding(value: unknown): { bindingId: string } {
  const input = rpcRecord(value, ['bindingId'])
  return { bindingId: identity(input.bindingId, 'INVALID_CONTROL_REQUEST') }
}

/** Metadata only. A diagnostic's original operation key is usable without native payload bytes. */
export function parseAgentExecutionInspection(value: unknown, expected: { bindingId: string } & Partial<Pick<AgentExecutionInspection,
  'agentHostId' | 'resourceHostId' | 'agentSessionId' | 'resourceWorkspacePath'>>): AgentExecutionInspection {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const result = rpcRecord(value, ['bindingId', 'agentHostId', 'resourceHostId', 'agentSessionId', 'resourceWorkspacePath', 'state', 'diagnostic', 'diagnostics', 'notices'], code)
  for (const field of ['bindingId', 'agentHostId', 'resourceHostId', 'agentSessionId']) identity(result[field], code)
  workspace(result.resourceWorkspacePath, code)
  for (const [field, original] of Object.entries(expected)) if (result[field] !== original) invalid('Execution observation belongs to another original binding.', code)
  if (result.state !== 'connected' && result.state !== 'unavailable' || (result.state === 'connected') === (result.diagnostic !== undefined)) invalid('Execution observation has inconsistent service state.', code)
  if (result.notices !== undefined) parseAgentExecutionNotices(result.notices, {}, code)
  const validateDiagnostic = (value: unknown, local: boolean): void => {
    const diagnostic = rpcRecord(value, local ? ['code', 'message', 'generation', 'operation', 'scope', 'side', 'runId'] : ['code', 'message', 'generation', 'operation'], code)
    if (local) {
      if (!['unclassified', 'helper', 'request', 'generation', 'operation'].includes(String(diagnostic.scope))) invalid('A local diagnostic must declare its original scope.', code)
      if (diagnostic.scope !== 'unclassified' || diagnostic.side !== undefined || diagnostic.runId !== undefined) {
        if (diagnostic.side !== 'frontend' && diagnostic.side !== 'executor') invalid('A local diagnostic must name its original helper side.', code)
        identity(diagnostic.runId, code)
      }
      if (diagnostic.scope === 'operation' && (diagnostic.side !== 'executor' || diagnostic.operation === undefined || diagnostic.generation === undefined)) invalid('Only an exact resource journal operation can carry operation scope.', code)
    }
    identity(diagnostic.code, code); text(diagnostic.message, code)
    if (diagnostic.generation !== undefined) identity(diagnostic.generation, code)
    if (diagnostic.operation !== undefined) {
      const operation = rpcRecord(diagnostic.operation, ['bindingId', 'streamGeneration', 'nativeRequestId'], code)
      identity(operation.bindingId, code); identity(operation.streamGeneration, code)
      if (operation.bindingId !== result.bindingId || diagnostic.generation !== undefined && operation.streamGeneration !== diagnostic.generation ||
          !(typeof operation.nativeRequestId === 'string' || typeof operation.nativeRequestId === 'number' && Number.isSafeInteger(operation.nativeRequestId))) {
        invalid('Execution diagnostic must retain its exact original operation identity.', code)
      }
    }
  }
  if (result.diagnostic !== undefined) validateDiagnostic(result.diagnostic, false)
  if (result.diagnostics !== undefined) {
    if (!Array.isArray(result.diagnostics)) invalid('Local execution diagnostics must be an array.', code)
    for (const diagnostic of result.diagnostics as unknown[]) validateDiagnostic(diagnostic, true)
  }
  return structuredClone(result) as unknown as AgentExecutionInspection
}
