import { AgentMuxError, parseAgentExecutionReference } from './errors.js'
import type { AgentExecutionReference } from './agent-execution-contract.js'
import { normalizeLaunchOptionSelection, type LaunchOptionSelection } from './agent-launch-option.js'
import { rpcRecord, rpcString } from './rpc-data.js'

export type AgentOpenContracts = { ordinaryLaunch: { revision: 1; destination: 'source-zone-background' } | null; externalAssociation: 1 | null; takeover: 1 | null }
export type AgentOpenDescription = { source: { runtimeId: string; ownerInstanceId: string }; contracts: AgentOpenContracts }
export const AGENT_OPEN_METHODS = { 'agent.open.describe': 'short' } as const
export type AgentOpenParams = { 'agent.open.describe': { expectedRuntimeId: string } }
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
  const p = rpcRecord(value, ['expectedRuntimeId'])
  return { expectedRuntimeId: rpcString(p.expectedRuntimeId, 'Original Source Runtime') }
}
export function parseAgentOpenDescription(value: unknown, input: AgentOpenParams['agent.open.describe']): AgentOpenDescription {
  const code = 'CONTROL_PROTOCOL_ERROR', p = rpcRecord(value, ['source','contracts'], code)
  const source = rpcRecord(p.source, ['runtimeId','ownerInstanceId'], code), contracts = rpcRecord(p.contracts, ['ordinaryLaunch','externalAssociation','takeover'], code)
  if (contracts.ordinaryLaunch !== null) {
    const launch = rpcRecord(contracts.ordinaryLaunch,['revision','destination'],code)
    if (launch.revision !== 1 || launch.destination !== 'source-zone-background') throw new AgentMuxError('The original Source launch destination contract is unconfirmed.',code)
  }
  if (source.runtimeId !== input.expectedRuntimeId || contracts.externalAssociation !== 1 && contracts.externalAssociation !== null || contracts.takeover !== 1 && contracts.takeover !== null) throw new AgentMuxError('The Source launch contracts are unconfirmed or belong to another Runtime.', code)
  if (typeof source.ownerInstanceId !== 'string' || !source.ownerInstanceId || /[\0\r\n]/u.test(source.ownerInstanceId)) throw new AgentMuxError('The original Source instance is unconfirmed.', code)
  return { source: { runtimeId: input.expectedRuntimeId, ownerInstanceId: source.ownerInstanceId }, contracts: contracts as AgentOpenContracts }
}

/** Caller-owned launch contribution. Source-generated context has a separate Core field. */
export type AgentOpenLaunchFields = { launchOptions?: LaunchOptionSelection; agentMuxNote?: string; cols?: number; rows?: number }
export const AGENT_OPEN_LAUNCH_FIELDS = ['launchOptions', 'agentMuxNote', 'cols', 'rows'] as const

/** Structure only; the selected Provider and original creation owner decide actual qualification. */
export function parseAgentOpenLaunchFields(input: Record<string, unknown>, code = 'INVALID_CONTROL_REQUEST'): AgentOpenLaunchFields {
  const result: AgentOpenLaunchFields = {}
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
