import { optionalInputEpoch } from './agent-prompt-condition.js'
import { parseAdoptedHostRoute } from './host-route.js'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute } from 'node:path'
import { AgentMuxError, parseAgentExecutionReference } from './errors.js'
import { parseAgentExecutionNotices } from './agent-execution-helper.js'
import { rpcRecord } from './rpc-data.js'
import { normalizeLaunchOptionSelection } from './agent-launch-option.js'
import { parseAgentNativeResumeSource } from './agent-native-sessions.js'
import { parseAgentCreationSpatialIntent } from "./agent-session-codec.js";
import { parseAgentMuxCreationAdmission } from './agent-creation-admission.js'
import type { AgentExecutionOpenInput, AgentExecutionInspection, AgentExecutionBindingObservation } from './agent-execution-coordinator.js'

export function parseAgentExecutionBindingObservation(value: unknown, bindingId: string): AgentExecutionBindingObservation {
  const result = rpcRecord(value, ['bindingId', 'inspection'], 'CONTROL_PROTOCOL_ERROR')
  if (result.bindingId !== bindingId) invalid('Execution observation belongs to another original binding.', 'CONTROL_PROTOCOL_ERROR')
  return { bindingId, inspection: result.inspection === null ? null : parseAgentExecutionInspection(result.inspection, { bindingId }) }
}

export const AGENT_EXECUTION_CREATE_FIELDS = ['bindingId', 'agentHostId', 'agentRuntimeId', 'resourceHostId', 'resourceRuntimeId', 'resourceWorkspacePath', 'resourceGrant', 'agent', 'agentRoute', 'resourceRoute', 'sourceRequestDigest'] as const
const agentFields = ['agentSessionId', 'createOperationId', 'inputEpoch', 'inputRuntimeId', 'executorId', 'executorRevision', 'workspacePath', 'prompt', 'agentMuxNote', 'sourceAgentMuxNote', 'agentMuxTask',
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
  for (const [field, runtime] of [['agentRoute', 'agentRuntimeId'], ['resourceRoute', 'resourceRuntimeId']] as const) if (input[field] !== undefined) {
    const route = parseAdoptedHostRoute(input[field])
    if (route.hops.at(-1)!.target.runtimeId !== input[runtime]) invalid('The adopted route names another original endpoint Runtime.', code)
  }
  if (input.sourceRequestDigest !== undefined && (typeof input.sourceRequestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sourceRequestDigest))) invalid('The original Source request digest must be SHA-256.', code)
  const grant = rpcRecord(input.resourceGrant, ['scope', 'bindingId'], code)
  if (grant.scope !== 'host-user' || grant.bindingId !== input.bindingId) invalid('The explicit resource grant must name this original execution binding.', code)
  const agent = rpcRecord(input.agent, agentFields, code)
  for (const field of ['agentSessionId', 'createOperationId', 'executorId', 'executorRevision']) identity(agent[field], code)
  workspace(agent.workspacePath, code)
  optionalInputEpoch(agent.inputEpoch)
  if (agent.inputRuntimeId !== undefined) identity(agent.inputRuntimeId, code)
  for (const field of ['prompt', 'agentMuxNote', 'sourceAgentMuxNote', 'agentMuxTask']) if (agent[field] !== undefined) text(agent[field], code)
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

export function parseAgentExecutionBinding(value: unknown, options: { associationView?: boolean } = {}): { bindingId: string; view?: 'association' } {
  const input = rpcRecord(value, options.associationView ? ['bindingId','view'] : ['bindingId'])
  if (input.view !== undefined && input.view !== 'association') invalid('Choose the original association witness view.', 'INVALID_CONTROL_REQUEST')
  return { bindingId: identity(input.bindingId, 'INVALID_CONTROL_REQUEST'), ...(input.view === undefined ? {} : { view: 'association' }) }
}

/** Metadata only. A diagnostic's original operation key is usable without native payload bytes. */
export function parseAgentExecutionInspection(value: unknown, expected: { bindingId: string } & Partial<Pick<AgentExecutionInspection,
  'agentHostId' | 'resourceHostId' | 'agentSessionId' | 'resourceWorkspacePath' | 'agentRoute' | 'resourceRoute'>> & { view?: 'association' }): AgentExecutionInspection {
  const code = 'CONTROL_PROTOCOL_ERROR'
  const result = rpcRecord(value, ['bindingId', 'agentHostId', 'resourceHostId', 'agentSessionId', 'resourceWorkspacePath', 'state', 'diagnostic', 'diagnostics', 'notices', 'continuation', 'helperStarts', 'agentRoute', 'resourceRoute', ...(expected.view === 'association' ? ['association'] : [])], code)
  for (const field of ['bindingId', 'agentHostId', 'resourceHostId', 'agentSessionId']) identity(result[field], code)
  workspace(result.resourceWorkspacePath, code)
  for (const field of ['agentRoute', 'resourceRoute']) if (result[field] !== undefined) parseAdoptedHostRoute(result[field])
  for (const [field, original] of Object.entries(expected)) if (field !== 'view' && !isDeepStrictEqual(result[field], original)) invalid('Execution observation belongs to another original binding.', code)
  if (result.state !== 'connected' && result.state !== 'unavailable' || (result.state === 'connected') === (result.diagnostic !== undefined)) invalid('Execution observation has inconsistent service state.', code)
  if (result.notices !== undefined) parseAgentExecutionNotices(result.notices, {}, code)
  if (result.continuation !== undefined) {
    const original = parseAgentExecutionReference(result.continuation)
    if (original.bindingId !== result.bindingId || original.agentSessionId !== result.agentSessionId) invalid('Continuation identifies another original execution.', code)
  }
  if (expected.view === 'association') {
    const witness = rpcRecord(result.association, ['state','reference','agentRuntimeId','resourceRuntimeId','resourceWorkspacePath','agent','sourceRequestDigest','issue'], code)
    const original = parseAgentExecutionReference(witness.reference)
    if (original.bindingId !== result.bindingId || original.agentSessionId !== result.agentSessionId || !isDeepStrictEqual(witness.reference, result.continuation)) invalid('Association witness belongs to another original creation.', code)
    if (witness.state === 'confirmed') {
      identity(witness.agentRuntimeId, code); identity(witness.resourceRuntimeId, code); workspace(witness.resourceWorkspacePath, code)
      if (witness.agent !== undefined) {
        const agent = rpcRecord(witness.agent, ['executorId','executorRevision','workspacePath'], code)
        identity(agent.executorId, code); identity(agent.executorRevision, code); workspace(agent.workspacePath, code)
      }
      if (witness.sourceRequestDigest !== undefined && (typeof witness.sourceRequestDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(witness.sourceRequestDigest))) invalid('The frozen Source request digest is invalid.', code)
      if (witness.resourceWorkspacePath !== result.resourceWorkspacePath || witness.issue !== undefined) invalid('Association witness has another resource or conflicting state.', code)
    } else if (witness.state === 'unconfirmed') {
      const issue = rpcRecord(witness.issue, ['code','message'], code)
      if (issue.code !== 'EXECUTION_RUNTIME_WITNESS_UNCONFIRMED' || typeof issue.message !== 'string' ||
          witness.agentRuntimeId !== undefined || witness.resourceRuntimeId !== undefined || witness.resourceWorkspacePath !== undefined || witness.agent !== undefined || witness.sourceRequestDigest !== undefined) invalid('Unconfirmed original Runtime facts cannot be filled from current routes.', code)
    } else invalid('Association witness has no explicit frozen fact state.', code)
  }
  if (result.helperStarts !== undefined) {
    const starts = rpcRecord(result.helperStarts, ['executor', 'frontend'], code)
    for (const role of ['executor', 'frontend']) {
      const start = rpcRecord(starts[role], ['outcome', 'runId'], code)
      if (!['not-submitted', 'unknown', 'confirmed'].includes(String(start.outcome)) || (start.outcome === 'confirmed' ? typeof start.runId !== 'string' || !start.runId : start.runId !== null)) invalid('Original helper Start facts are invalid.', code)
    }
  }
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
