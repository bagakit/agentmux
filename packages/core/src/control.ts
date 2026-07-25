import { AgentMuxError } from './errors.js'
import type { AgentExecutorId, AgentProviderId } from './types.js'

export const AGENTMUX_CONTROL_SCHEMA_VERSION = 5 as const

export type AgentMuxControlCaller = { agentSessionId: string }
export type AgentMuxRegionBounds = { x: number; y: number; width: number; height: number }
type AgentMuxRegionBase = { tabId: string; regionId: string; workspaceId: string }

export type AgentMuxAgentRegion = AgentMuxRegionBase & {
  kind: 'agent'
  agentSessionId: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
}
export type AgentMuxTerminalRegion = AgentMuxRegionBase & { kind: 'terminal'; runId: string }
export type AgentMuxBrowserRegion = AgentMuxRegionBase & { kind: 'browser'; browserId: string }
export type AgentMuxFileRegion = AgentMuxRegionBase & { kind: 'file'; path: string }
export type AgentMuxLauncherRegion = AgentMuxRegionBase & { kind: 'launcher' }
export type AgentMuxRegion = AgentMuxAgentRegion | AgentMuxTerminalRegion | AgentMuxBrowserRegion | AgentMuxFileRegion | AgentMuxLauncherRegion

export type AgentMuxRegionTarget =
  | { kind: 'region'; regionId: string }
  | { kind: 'agent-session'; agentSessionId: string }

export type AgentMuxInspectedRegion = AgentMuxRegion & { bounds: AgentMuxRegionBounds }
export type AgentMuxInspectedTab = { tabId: string; workspaceId: string; regions: AgentMuxInspectedRegion[] }

export type AgentMuxControlExecutor = {
  executorId: AgentExecutorId
  label: string
  providerId: AgentProviderId
  available: boolean
}

export type AgentMuxSelfAnchor = { kind: 'self' }
export type AgentMuxRegionAnchor = AgentMuxSelfAnchor | { kind: 'region'; regionId: string }
export type AgentMuxTabAnchor = AgentMuxSelfAnchor | { kind: 'tab'; tabId: string }
export type AgentMuxOpenDestination =
  | { kind: 'split'; region: AgentMuxRegionAnchor; direction: 'left' | 'right' | 'up' | 'down' }
  | { kind: 'new-tab'; after: AgentMuxTabAnchor }
  | { kind: 'launcher'; regionId: string }
export type AgentMuxOpenAgentContent =
  | { kind: 'new-agent'; executorId: AgentExecutorId; prompt?: string }
  | { kind: 'agent-session'; agentSessionId: string }

type RequestBase = { schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION; requestId: string }
export type AgentMuxControlInspectTabRequest = RequestBase & {
  operation: 'inspect.tab'; target: AgentMuxTabAnchor; caller?: AgentMuxControlCaller
}
export type AgentMuxControlInspectRegionRequest = RequestBase & {
  operation: 'inspect.region'; target: AgentMuxRegionAnchor; caller?: AgentMuxControlCaller
}
export type AgentMuxControlOpenAgentRequest = RequestBase & {
  operation: 'open.agent'; content: AgentMuxOpenAgentContent; destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller
}
export type AgentMuxMessageTarget =
  | AgentMuxSelfAnchor
  | { kind: 'agent-session'; agentSessionId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'region'; regionId: string }
export type AgentMuxControlSendRequest = RequestBase & {
  operation: 'send'; target: AgentMuxMessageTarget; text: string; caller?: AgentMuxControlCaller
}
export type AgentMuxControlFocusRequest = RequestBase & {
  operation: 'focus'; target: { kind: 'tab'; tabId: string } | { kind: 'region'; regionId: string }
}
export type AgentMuxControlListAgentsRequest = RequestBase & { operation: 'list.agents' }
export type AgentMuxSessionSelector = AgentMuxSelfAnchor | { kind: 'agent-session'; agentSessionId: string }
export type AgentMuxControlInterruptRequest = RequestBase & {
  operation: 'interrupt'; target: AgentMuxSessionSelector; caller?: AgentMuxControlCaller
}
export type AgentMuxControlResumeRequest = RequestBase & {
  operation: 'resume'; target: AgentMuxSessionSelector; text: string; caller?: AgentMuxControlCaller
}
export type AgentMuxControlStopRequest = RequestBase & {
  operation: 'stop'; target: AgentMuxSessionSelector; caller?: AgentMuxControlCaller
}
export type AgentMuxControlRequest =
  | AgentMuxControlInspectTabRequest
  | AgentMuxControlInspectRegionRequest
  | AgentMuxControlOpenAgentRequest
  | AgentMuxControlSendRequest
  | AgentMuxControlFocusRequest
  | AgentMuxControlListAgentsRequest
  | AgentMuxControlInterruptRequest
  | AgentMuxControlResumeRequest
  | AgentMuxControlStopRequest

export type AgentMuxControlResult =
  | { operation: 'inspect.tab'; tab: AgentMuxInspectedTab }
  | { operation: 'inspect.region'; region: AgentMuxInspectedRegion }
  | { operation: 'open.agent'; region: AgentMuxAgentRegion }
  | { operation: 'send'; agentSessionId: string }
  | { operation: 'focus'; tabId: string; regionId?: string }
  | { operation: 'list.agents'; agents: AgentMuxControlExecutor[] }
  | { operation: 'interrupt'; agentSessionId: string }
  | { operation: 'resume'; agentSessionId: string; runId: string }
  | { operation: 'stop'; agentSessionId: string }

type SuccessByOperation<Operation extends AgentMuxControlResult['operation']> = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION
  requestId: string
  ok: true
  operation: Operation
  result: Omit<Extract<AgentMuxControlResult, { operation: Operation }>, 'operation'>
}
export type AgentMuxControlSuccessReceipt = {
  [Operation in AgentMuxControlResult['operation']]: SuccessByOperation<Operation>
}[AgentMuxControlResult['operation']]
export type AgentMuxControlErrorReceipt = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION
  requestId: string | null
  ok: false
  operation: AgentMuxControlRequest['operation'] | null
  error: { code: string; message: string; candidates?: Array<{ agentSessionId: string; regionIds: string[] }> }
}
export type AgentMuxControlReceipt = AgentMuxControlSuccessReceipt | AgentMuxControlErrorReceipt
export interface AgentMuxControlHost { execute(request: AgentMuxControlRequest): Promise<AgentMuxControlResult> }

export function resolveAgentMuxRegion(regions: readonly AgentMuxRegion[], target: AgentMuxRegionTarget): AgentMuxRegion {
  if (new Set(regions.map(({ regionId }) => regionId)).size !== regions.length) throw new AgentMuxError('Open Region identity is ambiguous.', 'AMBIGUOUS_REGION_TARGET')
  const matches = regions.filter((region) => target.kind === 'region'
    ? region.regionId === target.regionId
    : region.kind === 'agent' && region.agentSessionId === target.agentSessionId)
  if (matches.length === 0) throw new AgentMuxError('Region target is not currently open.', 'REGION_NOT_OPEN')
  if (matches.length !== 1) throw new AgentMuxError('Region target is ambiguous.', 'AMBIGUOUS_REGION_TARGET')
  return structuredClone(matches[0]!)
}
