import { parseAdoptedHostRoute } from './host-route.js'
import { optionalInputEpoch } from './agent-prompt-condition.js'
import { AgentMuxError, parseAgentExecutionReference } from './errors.js'
import type { AgentExecutionReference } from './agent-execution-contract.js'
import { normalizeLaunchOptionSelection, type LaunchOptionSelection } from './agent-launch-option.js'
import { rpcRecord, rpcString } from './rpc-data.js'

export type AgentOpenContracts = { ordinaryLaunch: { revision: 1; destination: 'source-zone-background' } | null; externalAssociation: 1 | null; takeover: 1 | null }
export type AgentOpenExecutionSelector = { agentTarget: import('./space-control.js').AgentMuxSpaceAgentTarget | null }
export type AgentOpenExecutionDescription = { hostId: string; runtimeId: string; inputEpoch: string | null }
export type AgentOpenDescription = { sourceIssue?: {code:string;message:string}; execution?: AgentOpenExecutionDescription; source: { runtimeId: string; ownerInstanceId: string }; contracts: AgentOpenContracts }
export const AGENT_OPEN_METHODS = { 'agent.open.describe': 'short' } as const
export type AgentOpenParams = { 'agent.open.describe': { expectedRuntimeId: string; execution?: AgentOpenExecutionSelector; executionOnly?: true } }
export type AgentOpenResults = { 'agent.open.describe': AgentOpenDescription }
/** A locator for A's original Coordinator/Agent, never a B-to-A route or grant. */
export type CoordinatorAgentReference = { kind: 'coordinator-agent'; runtimeId: string; binding: AgentExecutionReference }
export type AgentAssociationResource = { runtimeId: string; workspaceId: string; workspacePath: string }
export function parseCoordinatorAgentReference(value: unknown): CoordinatorAgentReference {
  const p = rpcRecord(value, ['kind','runtimeId','binding'])
  if (p.kind !== 'coordinator-agent') throw new AgentMuxError('Keep the original external Coordinator reference.', 'INVALID_CONTROL_REQUEST')
  return { kind: p.kind, runtimeId: rpcString(p.runtimeId, 'Original Coordinator Runtime'), binding: structuredClone(parseAgentExecutionReference(p.binding)) }
}
export function parseAgentAssociationResource(value: unknown): AgentAssociationResource {
  const p = rpcRecord(value, ['runtimeId','workspaceId','workspacePath'])
  return { runtimeId: rpcString(p.runtimeId, 'Original Source Runtime'), workspaceId: rpcString(p.workspaceId, 'Original Source Workspace'),
    workspacePath: rpcString(p.workspacePath, 'Original Source directory') }
}
export function parseAgentOpenDescribe(value: unknown): AgentOpenParams['agent.open.describe'] {
  const p = rpcRecord(value, ['expectedRuntimeId', 'execution', 'executionOnly'])
  let execution: AgentOpenExecutionSelector | undefined
  if (p.execution !== undefined) {
    const choice = rpcRecord(p.execution, ['agentTarget'])
    if (choice.agentTarget === null) execution = { agentTarget: null }
    else {
      const target = rpcRecord(choice.agentTarget, ['hostId','runtimeId','adoptedRoute'])
      const runtimeId = rpcString(target.runtimeId, 'Original execution Runtime')
      const route = target.adoptedRoute === undefined ? undefined : parseAdoptedHostRoute(target.adoptedRoute)
      if (route && route.hops.at(-1)!.target.runtimeId !== runtimeId) throw new AgentMuxError('The original execution route names another Runtime.', 'HOST_ROUTE_TARGET_MISMATCH')
      execution = { agentTarget: { hostId: rpcString(target.hostId, 'Original execution Host'), runtimeId, ...(route ? { adoptedRoute: route } : {}) } }
    }
  }
  if (p.executionOnly !== undefined && (p.executionOnly !== true || !execution)) throw new AgentMuxError('An execution-only read requires its exact target selector.', 'INVALID_CONTROL_REQUEST')
  return { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original Source Runtime'), ...(execution ? { execution } : {}), ...(p.executionOnly ? { executionOnly: true as const } : {}) }
}
export function parseAgentOpenDescription(value: unknown, input: AgentOpenParams['agent.open.describe']): AgentOpenDescription {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['source','contracts','execution','sourceIssue'], code)
  const source = rpcRecord(p.source, ['runtimeId','ownerInstanceId'], code), contracts = rpcRecord(p.contracts, ['ordinaryLaunch','externalAssociation','takeover'], code)
  if (contracts.ordinaryLaunch !== null) {
    const launch = rpcRecord(contracts.ordinaryLaunch,['revision','destination'],code)
    if (launch.revision !== 1 || launch.destination !== 'source-zone-background') throw new AgentMuxError('The original Source launch destination contract is unconfirmed.',code)
  }
  if (source.runtimeId !== input.expectedRuntimeId || contracts.externalAssociation !== 1 && contracts.externalAssociation !== null || contracts.takeover !== 1 && contracts.takeover !== null) throw new AgentMuxError('The Source launch contracts are unconfirmed or belong to another Runtime.', code)
  if (typeof source.ownerInstanceId !== 'string' || !source.ownerInstanceId || /[\0\r\n]/u.test(source.ownerInstanceId)) throw new AgentMuxError('The original Source instance is unconfirmed.', code)
  let execution: AgentOpenExecutionDescription | undefined
  if (input.execution) {
    const original = rpcRecord(p.execution, ['hostId','runtimeId','inputEpoch'], code)
    const target = input.execution.agentTarget
    if (original.runtimeId !== (target?.runtimeId ?? input.expectedRuntimeId) || original.hostId !== (target?.hostId ?? 'local') || original.inputEpoch !== null && typeof original.inputEpoch !== 'string') throw new AgentMuxError('The input cut belongs to another exact execution target.', code)
    execution = { hostId: original.hostId as string, runtimeId: original.runtimeId as string, inputEpoch: original.inputEpoch === null ? null : optionalInputEpoch(original.inputEpoch).inputEpoch! }
  } else if (p.execution !== undefined) throw new AgentMuxError('Unrequested execution authority cannot be substituted.', code)
  const issue = p.sourceIssue === undefined ? undefined : rpcRecord(p.sourceIssue, ['code','message'], code)
  const sourceIssue = issue ? { code: rpcString(issue.code, 'Original contract issue'), message: rpcString(issue.message, 'Original contract issue') } : undefined
  return { source: { runtimeId: input.expectedRuntimeId, ownerInstanceId: source.ownerInstanceId }, contracts: contracts as AgentOpenContracts, ...(execution ? { execution } : {}), ...(sourceIssue ? { sourceIssue } : {}) }
}

/** Caller-owned launch contribution. Source-generated context has a separate Core field. */
export type AgentOpenLaunchFields = { inputRuntimeId?: string; inputEpoch?: string; launchOptions?: LaunchOptionSelection; agentMuxNote?: string; cols?: number; rows?: number }
export const AGENT_OPEN_LAUNCH_FIELDS = ['inputEpoch', 'inputRuntimeId', 'launchOptions', 'agentMuxNote', 'cols', 'rows'] as const

/** Structure only; the selected Provider and original creation owner decide actual qualification. */
export function parseAgentOpenLaunchFields(input: Record<string, unknown>, code = 'INVALID_CONTROL_REQUEST'): AgentOpenLaunchFields {
  const result: AgentOpenLaunchFields = { ...optionalInputEpoch(input.inputEpoch), ...(input.inputRuntimeId === undefined ? {} : { inputRuntimeId: rpcString(input.inputRuntimeId, 'Original input Runtime') }) }
  if (input.agentMuxNote !== undefined) {
    if (typeof input.agentMuxNote !== 'string') throw new AgentMuxError('The original AgentMux note must remain a string.', code)
    result.agentMuxNote = input.agentMuxNote
  }
  if (input.launchOptions !== undefined) {
    normalizeLaunchOptionSelection(input.launchOptions)
    // Keep authored empty selections in the immutable request; Provider canonicalization happens later.
    result.launchOptions = structuredClone(input.launchOptions) as LaunchOptionSelection
  }
  for (const key of ['cols', 'rows'] as const) if (input[key] !== undefined) {
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) <= 0) throw new AgentMuxError('Terminal dimensions must be positive safe integers.', code)
    result[key] = input[key] as number
  }
  return result
}
