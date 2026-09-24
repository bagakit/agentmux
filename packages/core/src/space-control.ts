/** Client-owned spatial facts. Core transports these without owning Git, directories or layouts. */
export type AgentMuxSpaceSelector = {
  spaceId?: string
  zoneId?: string
  tabId?: string
  regionId?: string
}
export type AgentMuxSpaceDestination = AgentMuxSpaceSelector & {
  newTab?: boolean
  split?: 'left' | 'right' | 'above' | 'below'
  newZone?:
    | { kind: 'worktree'; path: string; branch: string; createBranch: boolean }
    | { kind: 'directory'; path: string }
}
export type AgentMuxSpaceAddress = {
  spaceId: string
  zoneId: string
  workspaceId: string
  tabId: string
  regionId: string
}
export type AgentMuxSpaceFact = {
  spaceId: string
  kind: 'folder' | 'topic' | 'mote' | 'container'
  name: string
  hostId: string
  directoryPath: string
  projectId: string | null
  topicId?: string
  issue?: string
}
export type AgentMuxZoneFact = {
  zoneId: string
  spaceId: string
  workspaceId: string
  kind: 'directory' | 'worktree' | 'home'
  hostId: string
  directoryPath: string
  branch: string | null
}
export type AgentMuxSpaceTabFact = Omit<AgentMuxSpaceAddress, 'regionId'> & {
  groupId: string
  name: string | null
  regionIds: string[]
}
export type AgentMuxSpaceRegionFact = AgentMuxSpaceAddress & {
  kind: 'agent' | 'terminal' | 'browser' | 'file' | 'git-diff' | 'launcher'
  agentSessionId: string | null
  runId: string | null
  execution: { hostId: string; cwd: string } | null
}
export type AgentMuxSpaceCatalog = {
  spaces: AgentMuxSpaceFact[]
  zones: AgentMuxZoneFact[]
  tabs: AgentMuxSpaceTabFact[]
  regions: AgentMuxSpaceRegionFact[]
}
export type AgentMuxSpatialSave = {
  layoutApplied: boolean
  localStorageWritten: boolean
  storageFlushRequested: boolean
  /** Chromium's void flush API supplies no disk acknowledgement. */
  diskDurability: 'unconfirmed'
  reason: string | null
}
export type AgentMuxSpatialIssue = { step: string; code: string; message: string; recovery: string; candidates?: AgentMuxSpaceSelector[] }
export type AgentMuxSpaceAgentFact = {
  agentSessionId: string
  runId: string | null
  providerId: string | null
  executorId: string | null
  hostId: string
  cwd: string
  createOperationId: string | null
  initialPrompt: 'not-requested' | 'confirmed' | 'unconfirmed' | 'unknown'
}
export type AgentMuxSpaceMutationReport = {
  requestId: string
  outcome: 'opened' | 'moved' | 'unchanged' | 'partial' | 'unknown'
  from: AgentMuxSpaceAddress | null
  to: AgentMuxSpaceAddress | null
  agent: AgentMuxSpaceAgentFact | null
  resource: { hostId: string; path: string; workspaceId: string | null; kind: 'directory' | 'worktree'; branch: string | null } | null
  save: AgentMuxSpatialSave
  issues: AgentMuxSpatialIssue[]
}
type Base = { schemaVersion: 5; requestId: string }
export type AgentMuxSpaceControlRequest = Base & (
  | { operation: 'space.ls'; target: AgentMuxSpaceSelector }
  | { operation: 'space.inspect'; target: AgentMuxSpaceSelector | { requestId: string } }
  | { operation: 'agent.open'; content:
      | { kind: 'new-agent'; executorId: string; prompt?: string }
      | { kind: 'agent-session'; agentSessionId: string };
      destination: AgentMuxSpaceDestination; focus: boolean;
      caller?: { agentSessionId: string; capability?: string } }
  | { operation: 'space.mv'; fromRegionId: string; expectedAgentSessionId: string;
      destination: AgentMuxSpaceDestination; focus: boolean }
)
export type AgentMuxSpaceControlResult =
  | { operation: 'space.ls'; catalog: AgentMuxSpaceCatalog }
  | { operation: 'space.inspect'; catalog: AgentMuxSpaceCatalog; request?: { requestId: string; known: boolean; report: AgentMuxSpaceMutationReport | null } }
  | ({ operation: 'agent.open' } & AgentMuxSpaceMutationReport)
  | ({ operation: 'space.mv' } & AgentMuxSpaceMutationReport)
