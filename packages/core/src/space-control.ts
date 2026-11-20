import type { SplitDirection } from './split-direction-ssot.js'

/** Core spatial identities and relationships. Hosts retain Git, files, Native content and execution. */
/** true requests full names/recap; status reads original metadata and current status without history. */
export type AgentMuxSpacePresentationSelection = boolean | 'status'

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
/** Source-Core execution carrier plus semantic target; an adopted route is never a saved Host. */
export type AgentMuxSpaceAgentTarget = { hostId: string; runtimeId: string; adoptedRoute?: import('./host-route.js').AdoptedHostRoute }
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
  kind: 'agent' | 'terminal' | 'browser' | 'file' | 'git' | 'git-diff' | 'launcher'
  browserId?: string
  file?: { workspaceId: string; path: string; zoneRelativePath?: string; issue?: string }
  agentSessionId: string | null
  /** Locator for this original source admission, never permission to recreate it. */
  creationOperationId?: string
  /** External business association L, distinct from an Agent creation C. */
  association?: { operationId: string }
  runId: string | null
  execution: { hostId: string; cwd: string; runtimeId?: string } | null
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
  activities?: {
    agentSessionId: string; runId: string; expression: string
    /** Exact source Host; these optional fields qualify decoration only. */
    hostId?: string
    /** Remaining validity at this read, not a cross-device epoch or a control lease. */
    activeForMs?: number
  }[]
  parts?: Record<string, string>
  image?: { dataUrl: string | null; revision?: string }
  issue?: string
}
export type AgentMuxAgentPresentation = {
  agentSessionId: string; name: string; project: string; detail: string
  group: string; state: string; providerId: string
  recap: { text: string; source: string } | null
  avatar?: { tint?: string; badge?: string }
  /** Original client presentation, not control or execution authority. */
  stateMark?: 'error' | 'attention' | 'working' | 'results' | 'unknown' | 'interrupted' | 'recovery' | 'idle'
  stateLabel?: string
  presenceUnknown?: boolean
  /** Original task event / semantic state entry, never transport or byte activity. Presentation only. */
  lastActivityAt?: number | null
  projectGroup?: { key: string; projectId: string; hostId: string; name: string; spaceId: string | null }

}
/** Original Mote preferences observed by its client owner, never a Core preference store. */
export type AgentMuxMoteConversationReference = {
  hostId: string; sessionId: string
  displayWorkspaceId: string; groupId: string; tabId: string; regionId: string
}
export type AgentMuxMotePresentation = {
  spaceId: string
  /** The Mote's own files scope, independent of its member Zones and execution cwd. */
  content: { zoneId: string; hostId: string; workspaceId: string; workspacePath: string } | null
  quickMode:
    | { status: 'saved'; version: string; defaults: import('./mote/preferences.js').MoteQuickDefaults }
    | { status: 'missing' }
    | { status: 'unconfirmed'; message: string }
  /** The original owner's confirmed occurrence; an unavailable one remains in quickMode. */
  conversation: AgentMuxMoteConversationReference | null
  issue?: string
}
/** Client list groups, independent of Core Tab Groups and membership qualification. */
export type AgentMuxSurveyOrganization = {
  ungrouped: string[]
  groups: { groupId: string; name: string; collapsed: boolean; zoneIds: string[] }[]
}
/** One entry in the ordered client page preference, independent of Zone organization and Core topology. */
export type AgentMuxSurveyPageReference = { regionId: string; browserId: string }
/** The Browser remains the page identity; its optional view is one exact original Tab occurrence. */
export type AgentMuxSurveyPageSelection = { kind: 'page'; presentation?: { kind: 'tab' } &
  Pick<AgentMuxSpaceAddress, 'displayWorkspaceId' | 'groupId' | 'tabId' | 'regionId'> } & AgentMuxSurveyPageReference
/** Explicit presentation preference; neither pinning nor unpinning changes membership or resources. */
export type AgentMuxSurveyPinReference = { kind: 'zone'; zoneId: string } | ({ kind: 'page' } & AgentMuxSurveyPageReference)
export type AgentMuxSurveyPinChange = { reference: AgentMuxSurveyPinReference; pinned: boolean; expectedPinned: boolean }
export type AgentMuxSurveyPageAdmission = Pick<AgentMuxWorkfaceReport, 'save' | 'issues'> & {
  outcome: 'not-requested' | 'registered' | 'partial' | 'unknown'
  reference?: AgentMuxSurveyPageReference
}
/** Page arrays are ordered; expectedPageReferences must match the original complete order. */
export type AgentMuxSurveyCollectionChange = { zoneIds?: string[]; expectedZoneIds?: string[]; pageReferences?: AgentMuxSurveyPageReference[]; expectedPageReferences?: AgentMuxSurveyPageReference[] }
export type AgentMuxSurveyListReport = AgentMuxWorkfaceReport & {
  scope: 'survey-list'
  collectedZoneIds: string[]
  pageReferences: AgentMuxSurveyPageReference[]
  pinnedReferences?: AgentMuxSurveyPinReference[]
  storedOrganization: AgentMuxSurveyOrganization
  effectiveOrganization: AgentMuxSurveyOrganization
  outcome: 'read' | 'changed' | 'unchanged' | 'partial' | 'unknown' | 'refused'
}
export type AgentMuxSurveyProfileView = { kind: 'default' } | { kind: 'profile'; profileId: string }

/** Original Survey display preferences; missing topology does not retire these references. */
export type AgentMuxSurveyPresentation = {
  profileView: AgentMuxSurveyProfileView | null
  organization?: AgentMuxSurveyOrganization
  pinnedReferences?: AgentMuxSurveyPinReference[]
  items: { zoneId: string; name: string; issue?: string }[]
  pages: (AgentMuxSurveyPageReference & { name: string; profileId?: string; issue?: string })[]
  selection: {
    zoneId: string
    selection: { tabId: string; regionId: string }[]
    active: { tabId: string; regionId: string } | null
  } | AgentMuxSurveyPageSelection | null
  issue?: string
}
export type AgentMuxSpaceCatalog = {
  motePresentation?: AgentMuxMotePresentation[]
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
  clientStateWritten: boolean
  storageFlushRequested: boolean
  /** Confirmed only by the filesystem owner after file and directory fsync. */
  diskDurability: 'unconfirmed' | 'confirmed'
  reason: string | null
}
export type AgentMuxSpatialIssue = { step: string; code: string; message: string; recovery: string; candidates?: AgentMuxSpaceSelector[]; executionFailure?: import('./agent-execution-contract.js').AgentExecutionFailure }
export type AgentMuxSpaceAgentFact = {
  takeover?: import('./agent-takeover.js').AgentTakeoverProvenance
  /** Authoritative retirement of this exact Session/Run; never an active projection. */
  retirement?: { source: 'user'; observedAt: number }
  executorRevision?: string
  initialMessageOrigin?: import('./agent-creation-admission.js').AgentMuxCreationOrigin
  createdBy?: import('./agent-spawn.js').AgentMuxSpawnCreator
  createdRun?: import('./types.js').AgentMuxRunRef
  initialMessageId?: string
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
  toolExecution?: import('./agent-tool-execution.js').AgentToolExecutionBinding
}
export type AgentMuxSpaceMutationReport = {
  requestId: string
  outcome: 'opened' | 'moved' | 'unchanged' | 'partial' | 'unknown' | 'retired'
  from: AgentMuxSpaceAddress | null
  to: AgentMuxSpaceAddress | null
  agent: AgentMuxSpaceAgentFact | null
  /** Original Source-owned execution observation, under the binding reader's existing authority. */
  execution?: { coordinatorRuntimeId: string; reference: import('./agent-execution-contract.js').AgentExecutionReference;
    inspection: import('./agent-execution-coordinator.js').AgentExecutionInspection | null;
    /** The durable Source placement record is independent of the Coordinator intent. */
    placement?: 'retained' | 'unconfirmed';
    diagnostics?: import('./agent-execution-source-diagnostics.js').AgentExecutionSourceDiagnostics | null }
  /** A Source membership ACK, never an execution/Start or input receipt. */
  association?: { operationId: string; reference: import('./agent-open-contract.js').CoordinatorAgentReference; resource: import('./agent-open-contract.js').AgentAssociationResource }
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
  runtimeId?: string
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
export type AgentMuxWorkspaceAgentOrderMember = { hostId: string; agentSessionId: string }
/** Client presentation preference; does not mutate Session identity or spatial topology. */
export type AgentMuxWorkspaceAgentOrderReport = AgentMuxWorkfaceReport & {
  scope: 'workspace-agent-list'
  displayWorkspaceId: string
  storedOrder: AgentMuxWorkspaceAgentOrderMember[]
  effectiveOrder: AgentMuxWorkspaceAgentOrderMember[]
  outcome: 'read' | 'changed' | 'unchanged' | 'partial' | 'unknown' | 'refused'
}
type Base = { schemaVersion: 5; requestId: string }
export type AgentMuxSpaceControlRequest = Base & (
  | { operation: 'space.survey-list'; organization?: AgentMuxSurveyOrganization; expected?: AgentMuxSurveyOrganization; collection?: AgentMuxSurveyCollectionChange; pin?: AgentMuxSurveyPinChange }
  | { operation: 'space.agent-order'; displayWorkspaceId: string; order?: AgentMuxWorkspaceAgentOrderMember[]; expectedOrder?: AgentMuxWorkspaceAgentOrderMember[] }
  | ({ operation: 'space.mote.preferences.read' } & import('./mote/preferences.js').MotePreferencesReadInput)
  | ({ operation: 'space.mote.preferences.save' } & import('./mote/preferences.js').MotePreferencesSaveInput)
  | { operation: 'agent.view'; agentSessionId: string; runtimeId?: string; mode?: AgentMuxAgentViewMode }
  | { operation: 'space.view'; regionId: string; mode?: AgentMuxFileViewMode }
  | { operation: 'file.format'; regionId: string }
  | { operation: 'file.build'; regionId: string }
  | { operation: 'file.build.inspect'; regionId: string; buildId: string }
  | { operation: 'file.build.cancel'; regionId: string; buildId: string }
  | { operation: 'space.swap'; regionId: string; withRegionId: string }
  | { operation: 'open.file'; path: string; zoneId: string; spaceId?: string; displayWorkspaceId?: string; groupId?: string;
      /** Exact existing Tab and anchor Region; all three fields require the exact display occurrence. */
      tabId?: string; regionId?: string; split?: SplitDirection; focus: boolean }
  | { operation: 'agent.rename'; agentSessionId: string; name: string | null; expectedNameRevision: number; nameSource?: 'derived' }
  | { operation: 'agent.inspect'; agentSessionId: string }
  | { operation: 'space.rename'; tabId: string; name: string | null; expectedNameRevision: number; nameSource?: 'derived' }
  | { operation: 'space.ls'; target: AgentMuxSpaceSelector; presentation?: AgentMuxSpacePresentationSelection }
  | { operation: 'space.inspect'; presentation?: AgentMuxSpacePresentationSelection; target: AgentMuxSpaceSelector | { requestId: string } }
  | { operation: 'agent.open'; content:
      | ({ kind: 'new-agent'; executorId: string; agentTarget?: AgentMuxSpaceAgentTarget; executionWorkspaceId?: string; toolWorkspaceId?: string; nativeResumeSource?: import('./types.js').AgentNativeResumeSource; prompt?: string } & import('./agent-open-contract.js').AgentOpenLaunchFields)
      | ({ kind: 'takeover-agent'; executorId: string; agentTarget?: AgentMuxSpaceAgentTarget; source: import('./agent-takeover.js').AgentTakeoverSource } & import('./agent-open-contract.js').AgentOpenLaunchFields)
      | ({ kind: 'fork-agent'; source: import('./agent-fork.js').AgentMuxAgentForkSource; prompt?: string } & Pick<import('./agent-open-contract.js').AgentOpenLaunchFields, 'inputEpoch' | 'inputRuntimeId'>)
      /** A public request only: the Core service expands it into new-agent or fork-agent content before admission. */
      | ({ kind: 'derived-action'; actionId: string; source: { agentSessionId: string }; executorId?: string } & Pick<import('./agent-open-contract.js').AgentOpenLaunchFields, 'inputEpoch' | 'inputRuntimeId'>)
      | { kind: 'agent-session'; agentSessionId: string; reference?: never; expectedResource?: never }
      | { kind: 'agent-session'; reference: import('./agent-open-contract.js').CoordinatorAgentReference; expectedResource: import('./agent-open-contract.js').AgentAssociationResource; agentSessionId?: never };
      destination: AgentMuxSpaceDestination; focus: boolean;
      moteMain?: import('./spatial-agent-open-contract.js').MoteMainCreationIntent;
      caller?: { agentSessionId: string; capability?: string } }
  | { operation: 'space.bind'; binding: AgentMuxSpaceBindingTarget }
  | { operation: 'space.unbind'; binding: AgentMuxSpaceBindingTarget }
  | { operation: 'space.mv'; fromRegionId: string; expectedAgentSessionId: string;
      fromLocation?: Pick<AgentMuxSpaceSelector, 'spaceId' | 'displayWorkspaceId' | 'groupId'>;
      destination: AgentMuxSpaceDestination; focus: boolean }
)
export type AgentMuxSpaceControlResult =
  | ({ operation: 'space.survey-list' } & AgentMuxSurveyListReport)
  | ({ operation: 'space.agent-order' } & AgentMuxWorkspaceAgentOrderReport)
  | ({ operation: 'space.mote.preferences.read' } & import('./mote/preferences.js').MotePreferencesReadResult)
  | ({ operation: 'space.mote.preferences.save'; requestId: string } & import('./mote/preferences.js').MotePreferencesSaveControlResult)
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
  | { operation: 'space.inspect'; catalog: AgentMuxSpaceCatalog; request?: { requestId: string; known: boolean; report: AgentMuxSpaceMutationReport | null;
    observationIssue?: { code: string; message: string } } }
  | ({ operation: 'space.bind' } & AgentMuxSpaceBindingReport)
  | ({ operation: 'space.unbind' } & AgentMuxSpaceBindingReport)
  | ({ operation: 'agent.open' } & AgentMuxSpaceMutationReport)
  | ({ operation: 'space.mv' } & AgentMuxSpaceMutationReport)
