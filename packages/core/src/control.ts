import { AgentMuxError } from './errors.js'
import type { AgentExecutorId, AgentProviderId } from './types.js'

export const AGENTMUX_CONTROL_SCHEMA_VERSION = 5 as const

export const AGENTMUX_CONTROL_ERROR_CODES = [
  'INVALID_CONTROL_REQUEST',
  'CONTROL_PROTOCOL_ERROR',
  'CONTROL_TIMEOUT',
  'CONTROL_UNAVAILABLE',
  'CONTROL_OWNER_BUSY',
  'CONTROL_FAILED',
  'CONTROL_CANCELLED',
  'CONTROL_REQUEST_CONFLICT',
  'CONTROL_OWNER_LOST',
  'CALLER_NOT_OPEN',
  'TAB_NOT_OPEN',
  'REGION_NOT_OPEN',
  'AMBIGUOUS_TAB_TARGET',
  'AMBIGUOUS_REGION_TARGET',
  'MESSAGE_TARGET_NOT_UNIQUE',
  'MESSAGE_TARGET_NOT_AGENT',
  'AGENT_EXECUTOR_NOT_CONFIGURED',
  'UNKNOWN_AGENT_SESSION',
  'SESSION_CLOSING',
  'SESSION_NOT_RUNNING',
  'UNKNOWN_WORKSPACE',
  'REGION_WORKSPACE_MISMATCH',
  'REGION_TOPIC_MISMATCH',
  'LAUNCH_RESULT_MISMATCH',
  'LAUNCH_CLEANUP_FAILED',
  'LAYOUT_CAPACITY_EXCEEDED',
  'LAUNCHER_REGION_REQUIRED',
  'AGENT_NOT_FOUND',
  'INVALID_AGENT_PROMPT',
  'AGENT_SESSION_STILL_RUNNING',
  'AGENT_RESUME_UNAVAILABLE',
  'AGENT_RESUME_UNSUPPORTED',
  'STALE_AGENT_SESSION',
  'STALE_AGENT_SESSION_BINDING',
  'CTXMUX_DISCONNECTED',
  'CTXMUX_INPUT_CURSOR_MISSING',
  'SIGNAL_UNSUPPORTED'
] as const
export type AgentMuxControlErrorCode = typeof AGENTMUX_CONTROL_ERROR_CODES[number]

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
export type AgentMuxArrangeMode =
  | { kind: 'preset'; preset: 'columns-3' | 'grid-4' | 'grid-6' | 'grid-9' }
  | { kind: 'balance' }
  | { kind: 'active-first' }

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
export type AgentMuxControlOpenTerminalRequest = RequestBase & {
  operation: 'open.terminal'; shellCommand?: string; destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller
}
export type AgentMuxControlOpenBrowserRequest = RequestBase & {
  operation: 'open.browser'; url: string; destination: AgentMuxOpenDestination; caller?: AgentMuxControlCaller
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
export type AgentMuxControlArrangeRequest = RequestBase & {
  operation: 'arrange'; target: AgentMuxTabAnchor; mode: AgentMuxArrangeMode; caller?: AgentMuxControlCaller
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
  | AgentMuxControlOpenTerminalRequest
  | AgentMuxControlOpenBrowserRequest
  | AgentMuxControlSendRequest
  | AgentMuxControlFocusRequest
  | AgentMuxControlArrangeRequest
  | AgentMuxControlListAgentsRequest
  | AgentMuxControlInterruptRequest
  | AgentMuxControlResumeRequest
  | AgentMuxControlStopRequest

export type AgentMuxControlResult =
  | { operation: 'inspect.tab'; tab: AgentMuxInspectedTab }
  | { operation: 'inspect.region'; region: AgentMuxInspectedRegion }
  | { operation: 'open.agent'; region: AgentMuxAgentRegion }
  | { operation: 'open.terminal'; region: AgentMuxTerminalRegion }
  | { operation: 'open.browser'; region: AgentMuxBrowserRegion }
  | { operation: 'send'; agentSessionId: string }
  | { operation: 'focus'; tabId: string; regionId?: string }
  | { operation: 'arrange'; tab: AgentMuxInspectedTab }
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
export type AgentMuxMessageTargetCandidate = { agentSessionId: string; regionIds: string[] }
export type AgentMuxControlError =
  | { code: 'MESSAGE_TARGET_NOT_UNIQUE'; message: string; candidates: AgentMuxMessageTargetCandidate[] }
  | {
      code: Exclude<AgentMuxControlErrorCode, 'MESSAGE_TARGET_NOT_UNIQUE'>
      message: string
      candidates?: never
    }
export type AgentMuxControlErrorReceipt = {
  schemaVersion: typeof AGENTMUX_CONTROL_SCHEMA_VERSION
  requestId: string | null
  ok: false
  operation: AgentMuxControlRequest['operation'] | null
  error: AgentMuxControlError
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
