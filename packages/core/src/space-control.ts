/** Client-owned spatial facts. Core transports these without owning Git, directories or layouts. */
export type AgentMuxSpaceSelector = {
  spaceId?: string
  zoneId?: string
  tabId?: string
  regionId?: string
  displayWorkspaceId?: string
  groupId?: string
}
export type AgentMuxSpaceDestination = AgentMuxSpaceSelector & {
  newTab?: boolean
  split?: 'left' | 'right' | 'above' | 'below'
  newZone?:
    | { kind: 'worktree'; path: string; branch: string; createBranch: boolean }
    | { kind: 'directory'; path: string }
}
export type AgentMuxSpaceAddress = {
  spaceId: string | null
  zoneId: string | null
  workspaceId: string
  displayWorkspaceId: string
  groupId: string
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
  /** Resource context, independent of every display binding. */
  workspaceId: string
  kind: 'directory' | 'worktree' | 'home' | 'unknown'
  hostId: string | null
  directoryPath: string | null
  branch: string | null
  issue?: string
}
export type AgentMuxSpaceTabFact = {
  tabId: string
  zoneId: string | null
  workspaceId: string
  name: string | null
  regionIds: string[]
  issue?: string
}
export type AgentMuxSpaceRegionFact = {
  regionId: string
  tabId: string
  kind: 'agent' | 'terminal' | 'browser' | 'file' | 'git-diff' | 'launcher'
  agentSessionId: string | null
  runId: string | null
  execution: { hostId: string; cwd: string } | null
}
export type AgentMuxSpaceBindingFact = { zoneId: string; spaceId: string }
/** Navigable references, not a claim that a Native surface is mounted. */
export type AgentMuxSpaceLocation = AgentMuxSpaceAddress
export type AgentMuxSpaceCatalog = {
  spaces: AgentMuxSpaceFact[]
  zones: AgentMuxZoneFact[]
  tabs: AgentMuxSpaceTabFact[]
  regions: AgentMuxSpaceRegionFact[]
  bindings: AgentMuxSpaceBindingFact[]
  locations: AgentMuxSpaceLocation[]
}
export type AgentMuxSpaceBindingTarget =
  | { kind: 'zone-space'; zoneId: string; spaceId: string }
  | { kind: 'tab-group'; tabId: string; displayWorkspaceId: string; groupId: string }
export type AgentMuxSpaceBindingReport = {
  requestId: string
  outcome: 'linked' | 'unlinked' | 'unchanged' | 'unknown'
  binding: AgentMuxSpaceBindingTarget
  catalog: AgentMuxSpaceCatalog
  save: AgentMuxSpatialSave
  issues: AgentMuxSpatialIssue[]
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
export type AgentMuxDisplayNameReport = {
  override: string | null
  changed: boolean
  outcome: 'renamed' | 'unchanged' | 'partial'
  save: AgentMuxSpatialSave
}
export type AgentMuxAgentViewMode = 'terminal' | 'activity'
export type AgentMuxFileViewMode = 'source' | 'diff' | 'preview'
/** Applied state and save acknowledgement are separate from content availability. */
export type AgentMuxWorkfaceReport = {
  changed: boolean
  save: AgentMuxSpatialSave | null
  issues: AgentMuxSpatialIssue[]
}
export type AgentMuxAgentViewReport = AgentMuxWorkfaceReport & {
  scope: 'agent-session'
  agentSessionId: string
  storedOverride: AgentMuxAgentViewMode | null
  effectiveMode: AgentMuxAgentViewMode | null
  sessionFacts: 'known' | 'unconfirmed'
  regions: AgentMuxSpaceRegionFact[]
  locations: AgentMuxSpaceLocation[]
  outcome: 'read' | 'changed' | 'unchanged' | 'partial' | 'unknown' | 'refused'
}
export type AgentMuxFileViewReport = AgentMuxWorkfaceReport & {
  scope: 'file-region'
  regionId: string
  tabId: string | null
  workspaceId: string | null
  storedOverride: AgentMuxFileViewMode | null
  effectiveMode: AgentMuxFileViewMode | null
  supportedModes: AgentMuxFileViewMode[] | null
  data: 'text' | 'media-preview' | 'binary-preview' | 'failed' | 'unconfirmed'
  content: { status: 'available' | 'loading' | 'failed' | 'unconfirmed'; reason: string | null }
  locations: AgentMuxSpaceLocation[]
  outcome: 'read' | 'changed' | 'unchanged' | 'partial' | 'unknown' | 'refused'
}
export type AgentMuxRegionSwapReport = AgentMuxWorkfaceReport & {
  scope: 'tab-layout'
  regionId: string
  withRegionId: string
  tabId: string | null
  workspaceId: string | null
  beforeOrder: string[]
  afterOrder: string[]
  activeRegionId: string | null
  locations: AgentMuxSpaceLocation[]
  outcome: 'swapped' | 'unchanged' | 'partial' | 'unknown' | 'refused'
}
export type AgentMuxFileOpenReport = AgentMuxWorkfaceReport & {
  requestedPath: string
  resource: { hostId: string; workspaceId: string; workspacePath: string; zoneId: string; zonePath: string; path: string } | null
  placement: { status: 'created' | 'reused' | 'none' | 'unconfirmed'; tabId: string | null; regionId: string | null; locations: AgentMuxSpaceLocation[] }
  data: { kind: 'text' | 'media-preview' | 'binary-preview' | 'not-file' | 'failed' | 'unconfirmed'; reason: string | null }
  navigation: 'background' | 'applied' | 'cancelled' | 'unconfirmed'
  outcome: 'opened' | 'unchanged' | 'partial' | 'unknown' | 'refused'
}
type Base = { schemaVersion: 5; requestId: string }
export type AgentMuxSpaceControlRequest = Base & (
  | { operation: 'agent.view'; agentSessionId: string; mode?: AgentMuxAgentViewMode }
  | { operation: 'space.view'; regionId: string; mode?: AgentMuxFileViewMode }
  | { operation: 'space.swap'; regionId: string; withRegionId: string }
  | { operation: 'open.file'; path: string; zoneId: string; spaceId?: string; displayWorkspaceId?: string; groupId?: string; focus: boolean }
  | { operation: 'agent.rename'; agentSessionId: string; name: string | null }
  | { operation: 'agent.inspect'; agentSessionId: string }
  | { operation: 'space.rename'; tabId: string; name: string | null }
  | { operation: 'space.ls'; target: AgentMuxSpaceSelector }
  | { operation: 'space.inspect'; target: AgentMuxSpaceSelector | { requestId: string } }
  | { operation: 'agent.open'; content:
      | { kind: 'new-agent'; executorId: string; prompt?: string }
      | { kind: 'agent-session'; agentSessionId: string };
      destination: AgentMuxSpaceDestination; focus: boolean;
      caller?: { agentSessionId: string; capability?: string } }
  | { operation: 'space.bind'; binding: AgentMuxSpaceBindingTarget }
  | { operation: 'space.unbind'; binding: AgentMuxSpaceBindingTarget }
  | { operation: 'space.mv'; fromRegionId: string; expectedAgentSessionId: string;
      fromLocation?: Pick<AgentMuxSpaceSelector, 'spaceId' | 'displayWorkspaceId' | 'groupId'>;
      destination: AgentMuxSpaceDestination; focus: boolean }
)
export type AgentMuxSpaceControlResult =
  | ({ operation: 'agent.view' } & AgentMuxAgentViewReport)
  | ({ operation: 'space.view' } & AgentMuxFileViewReport)
  | ({ operation: 'space.swap' } & AgentMuxRegionSwapReport)
  | ({ operation: 'open.file' } & AgentMuxFileOpenReport)
  | ({ operation: 'agent.rename'; agentSessionId: string } & AgentMuxDisplayNameReport)
  | { operation: 'agent.inspect'; agentSessionId: string; override: string | null }
  | ({ operation: 'space.rename'; tabId: string } & AgentMuxDisplayNameReport)
  | { operation: 'space.ls'; catalog: AgentMuxSpaceCatalog }
  | { operation: 'space.inspect'; catalog: AgentMuxSpaceCatalog; request?: { requestId: string; known: boolean; report: AgentMuxSpaceMutationReport | null } }
  | ({ operation: 'space.bind' } & AgentMuxSpaceBindingReport)
  | ({ operation: 'space.unbind' } & AgentMuxSpaceBindingReport)
  | ({ operation: 'agent.open' } & AgentMuxSpaceMutationReport)
  | ({ operation: 'space.mv' } & AgentMuxSpaceMutationReport)
