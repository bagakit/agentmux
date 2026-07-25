import { AgentMuxError } from './errors.js'
import type { AgentExecutorId, AgentProviderId } from './types.js'

export const AGENTMUX_COMPOSITION_SCHEMA_VERSION = 4 as const

export type AgentMuxRegionPlacement =
  | 'tab'
  | 'split-left'
  | 'split-right'
  | 'split-up'
  | 'split-down'

export type AgentMuxRelativeRegion =
  | { kind: 'self' }
  | { kind: 'region'; regionId: string }

type AgentMuxRegionBase = {
  viewId: string
  regionId: string
  workspaceId: string
  tabGroupId: string
}

export type AgentMuxTerminalRegion = AgentMuxRegionBase & {
  kind: 'terminal'
  runId: string
}

export type AgentMuxAgentRegion = AgentMuxRegionBase & {
  kind: 'agent'
  agentSessionId: string
}

export type AgentMuxRegion = AgentMuxTerminalRegion | AgentMuxAgentRegion

export type AgentMuxRegionTarget =
  | { kind: 'region'; regionId: string }
  | { kind: 'agent-session'; agentSessionId: string }

export type AgentMuxCompositionCaller = {
  agentSessionId: string
}

export type AgentMuxRegionBounds = {
  x: number
  y: number
  width: number
  height: number
}

type AgentMuxCompositionViewRegionBase = {
  regionId: string
  bounds: AgentMuxRegionBounds
}

export type AgentMuxCompositionViewRegion =
  | AgentMuxCompositionViewRegionBase & {
      kind: 'agent'
      providerId: AgentProviderId
      executorId: AgentExecutorId
      agentSessionId: string
    }
  | AgentMuxCompositionViewRegionBase & {
      kind: 'terminal'
      runId: string
    }
  | AgentMuxCompositionViewRegionBase & {
      kind: 'other'
    }

type AgentMuxCompositionRequestBase = {
  schemaVersion: typeof AGENTMUX_COMPOSITION_SCHEMA_VERSION
  requestId: string
}

export type AgentMuxCompositionContextRequest = AgentMuxCompositionRequestBase & {
  operation: 'context'
  caller: AgentMuxCompositionCaller
}

export type AgentMuxCompositionOpenRegionRequest = AgentMuxCompositionRequestBase & {
  operation: 'region.open'
  caller: AgentMuxCompositionCaller
  agentSessionId: string
  placement: AgentMuxRegionPlacement
  relativeTo: AgentMuxRelativeRegion
}

export type AgentMuxCompositionFocusRegionRequest = AgentMuxCompositionRequestBase & {
  operation: 'region.focus'
  regionId: string
}

export type AgentMuxCompositionLaunchRequest = AgentMuxCompositionRequestBase & {
  operation: 'launch'
  caller: AgentMuxCompositionCaller
  executorId: AgentExecutorId
  prompt?: string
  placement: AgentMuxRegionPlacement
  relativeTo: AgentMuxRelativeRegion
}

export type AgentMuxCompositionRequest =
  | AgentMuxCompositionContextRequest
  | AgentMuxCompositionOpenRegionRequest
  | AgentMuxCompositionFocusRegionRequest
  | AgentMuxCompositionLaunchRequest

export type AgentMuxCompositionContext = {
  agentSessionId: string
  workspaceId: string
  viewId: string
  regionId: string
  tabGroupId: string
  regions: AgentMuxCompositionViewRegion[]
  executors: AgentMuxCompositionExecutor[]
}

export type AgentMuxCompositionExecutor = {
  executorId: AgentExecutorId
  label: string
  providerId: AgentProviderId
  available: boolean
}

export type AgentMuxCompositionResult =
  | { operation: 'context'; context: AgentMuxCompositionContext }
  | { operation: 'region.open'; region: AgentMuxAgentRegion }
  | { operation: 'region.focus'; region: AgentMuxRegion }
  | { operation: 'launch'; agentSessionId: string; region: AgentMuxAgentRegion }

type AgentMuxCompositionSuccessReceiptByOperation<
  Operation extends AgentMuxCompositionResult['operation']
> = {
  schemaVersion: typeof AGENTMUX_COMPOSITION_SCHEMA_VERSION
  requestId: string
  ok: true
  operation: Operation
  result: Omit<Extract<AgentMuxCompositionResult, { operation: Operation }>, 'operation'>
}

export type AgentMuxCompositionSuccessReceipt = {
  [Operation in AgentMuxCompositionResult['operation']]:
    AgentMuxCompositionSuccessReceiptByOperation<Operation>
}[AgentMuxCompositionResult['operation']]

export type AgentMuxCompositionErrorReceipt = {
  schemaVersion: typeof AGENTMUX_COMPOSITION_SCHEMA_VERSION
  requestId: string | null
  ok: false
  operation: AgentMuxCompositionRequest['operation'] | null
  error: {
    code: string
    message: string
  }
}

export type AgentMuxCompositionReceipt =
  | AgentMuxCompositionSuccessReceipt
  | AgentMuxCompositionErrorReceipt

export interface AgentMuxCompositionControl {
  execute(request: AgentMuxCompositionRequest): Promise<AgentMuxCompositionResult>
}

export function resolveAgentMuxRegion(
  regions: readonly AgentMuxRegion[],
  target: AgentMuxRegionTarget
): AgentMuxRegion {
  if (new Set(regions.map((region) => region.regionId)).size !== regions.length) {
    throw new AgentMuxError('Open Region identity is ambiguous.', 'AMBIGUOUS_REGION_TARGET')
  }
  const matches = regions.filter((region) => target.kind === 'region'
    ? region.regionId === target.regionId
    : region.kind === 'agent' && region.agentSessionId === target.agentSessionId)
  if (matches.length === 0) {
    throw new AgentMuxError('Region target is not currently open.', 'REGION_NOT_OPEN')
  }
  if (matches.length !== 1) {
    throw new AgentMuxError('Region target is ambiguous.', 'AMBIGUOUS_REGION_TARGET')
  }
  return structuredClone(matches[0]!)
}
