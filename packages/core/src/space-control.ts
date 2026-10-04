import type { SplitDirection } from './split-direction-ssot.js'

/** Core spatial identities and relationships. Hosts retain Git, files, Native content and execution. */
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
  split?: import('./split-direction-ssot.js').SplitDirection
  newZone?:
    | { kind: 'worktree'; projectId: string; sourceWorkspaceId?: string; path: string; branch: string; createBranch: boolean }
    | { kind: 'directory'; projectId: string; sourceWorkspaceId?: string; path: string }
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
  /** Current label owner revision; layout snapshots do not own this value. */
  nameRevision?: number
  regionIds: string[]
  issue?: string
}
export type AgentMuxSpaceRegionFact = {
  regionId: string
  tabId: string
  kind: 'agent' | 'terminal' | 'browser' | 'file' | 'git-diff' | 'launcher'
  browserId?: string
  file?: { workspaceId: string; path: string; zoneRelativePath?: string; issue?: string }
  agentSessionId: string | null
  runId: string | null
  execution: { hostId: string; cwd: string } | null
}
export type AgentMuxSpaceBindingFact = { zoneId: string; spaceId: string }
/** Navigable references, not a claim that a Native surface is mounted. */
export type AgentMuxSpaceLocation = AgentMuxSpaceAddress
/** Manual organization of original Projects; the group has no execution resource. */
export type AgentMuxProjectGroupFact = {
  groupId: string
  name: string
  projectIds: string[]
}
/** Read-only host appearance facts. They never own spatial or execution identity. */
export type AgentMuxSpaceAppearance = {
  spaceId: string
  glyph?: string
  preset?: string
  expression?: string
  activities?: { agentSessionId: string; runId: string; expression: string }[]
  parts?: Record<string, string>
  image?: { dataUrl: string | null; revision?: string }
  issue?: string
}
export type AgentMuxAgentPresentation = {
  agentSessionId: string; name: string; project: string; detail: string
  group: string; state: string; providerId: string
  recap: { text: string; source: string } | null
  avatar?: { tint?: string; badge?: string }
}
/** Original Survey display preferences; missing topology does not retire these references. */
export type AgentMuxSurveyPresentation = {
  items: { zoneId: string; name: string; issue?: string }[]
  selection: {
    zoneId: string
    selection: { tabId: string; regionId: string }[]
    active: { tabId: string; regionId: string } | null
  } | null
  issue?: string
}
export type AgentMuxSpaceCatalog = {
  survey?: AgentMuxSurveyPresentation
  agentPresentation?: AgentMuxAgentPresentation[]
  appearance?: AgentMuxSpaceAppearance[]
  projectGroups?: AgentMuxProjectGroupFact[]
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
  /** Confirmed only by the filesystem owner after file and directory fsync. */
  diskDurability: 'unconfirmed' | 'confirmed'
  reason: string | null
}
export type AgentMuxSpatialIssue = { step: string; code: string; message: string; recovery: string; candidates?: AgentMuxSpaceSelector[] }
export type AgentMuxSpaceAgentFact = {
  executorRevision?: string
  initialMessageOrigin?: import('./agent-creation-admission.js').AgentMuxCreationOrigin
  agentSessionId: string
  runId: string | null
  providerId: string | null
  executorId: string | null
  hostId: string
  cwd: string
  createOperationId: string | null
  initialPrompt: 'not-requested' | 'confirmed' | 'unconfirmed' | 'unknown'
  agentMuxContext?: 'confirmed' | 'unconfirmed' | 'unknown'
  creationPersistence?: 'unconfirmed'
  creationFailure?: { step: 'session-commit' | 'hook-bind' | 'handshake'; code: string; message: string }
  forkedFrom?: import('./agent-fork.js').AgentMuxAgentForkSource
}
export type AgentMuxSpaceMutationReport = {
  requestId: string
  outcome: 'opened' | 'moved' | 'unchanged' | 'partial' | 'unknown'
  from: AgentMuxSpaceAddress | null
  to: AgentMuxSpaceAddress | null
  agent: AgentMuxSpaceAgentFact | null
  resource: { projectId: string | null; sourceWorkspaceId: string | null; hostId: string; path: string; workspaceId: string | null; kind: 'directory' | 'worktree'; branch: string | null } | null
  save: AgentMuxSpatialSave
  issues: AgentMuxSpatialIssue[]
}
export type AgentMuxDisplayNameReport = {
  override: string | null
  changed: boolean
  outcome: 'renamed' | 'unchanged' | 'partial'
  save: AgentMuxSpatialSave
  nameRevision: number
  record: import('./display-label.js').AgentMuxNameChangeRecord
}
export type AgentMuxAgentViewMode = 'terminal' | 'activity'
export type AgentMuxFileViewMode = 'source' | 'diff' | 'preview'
export type AgentMuxFileFormatReport = {
  regionId: string
  status: 'formatted' | 'unchanged' | 'unsupported' | 'unavailable' | 'stale' | 'cancelled' | 'failed'
  message: string | null
}
/** Ephemeral compilation of an original File draft; artifact bytes stay with the client. */
export type AgentMuxFileBuildReport = {
  regionId: string
  buildId: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unavailable' | 'unknown' | 'stale' | 'missing' | 'unsupported'
  message: string | null
  log: string
  artifact: { kind: 'pdf'; byteLength: number } | null
}
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
  | { operation: 'file.format'; regionId: string }
  | { operation: 'file.build'; regionId: string }
  | { operation: 'file.build.inspect'; regionId: string; buildId: string }
  | { operation: 'file.build.cancel'; regionId: string; buildId: string }
  | { operation: 'space.swap'; regionId: string; withRegionId: string }
  | { operation: 'open.file'; path: string; zoneId: string; spaceId?: string; displayWorkspaceId?: string; groupId?: string;
      /** Exact existing Tab and anchor Region; all three fields require the exact display occurrence. */
      tabId?: string; regionId?: string; split?: SplitDirection; focus: boolean }
  | { operation: 'agent.rename'; agentSessionId: string; name: string | null; expectedNameRevision: number }
  | { operation: 'agent.inspect'; agentSessionId: string }
  | { operation: 'space.rename'; tabId: string; name: string | null; expectedNameRevision: number }
  | { operation: 'space.ls'; target: AgentMuxSpaceSelector; presentation?: boolean }
  | { operation: 'space.inspect'; presentation?: boolean; target: AgentMuxSpaceSelector | { requestId: string } }
  | { operation: 'agent.open'; content:
      | { kind: 'new-agent'; executorId: string; executionWorkspaceId?: string; prompt?: string }
      | { kind: 'fork-agent'; source: import('./agent-fork.js').AgentMuxAgentForkSource; prompt?: string }
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
  | ({ operation: 'file.format' } & AgentMuxFileFormatReport)
  | ({ operation: 'file.build' } & AgentMuxFileBuildReport)
  | ({ operation: 'file.build.inspect' } & AgentMuxFileBuildReport)
  | ({ operation: 'file.build.cancel' } & AgentMuxFileBuildReport)
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
