import type { AgentMuxSpaceSelector, AgentMuxSpatialIssue, AgentMuxSpatialSave, AgentMuxSurveyPinReference, AgentMuxSurveyPresentation, AgentMuxSpaceAddress } from './space-control.js'

/** Client presentation facts. Core neither owns nor initializes a desktop surface. */
export type AgentMuxDesktopSurface = 'space' | 'focus' | 'goals' | 'survey' | 'recall'
export type AgentMuxDesktopFocusView = 'list' | 'map'
export type AgentMuxDesktopMainSurface = 'workbench' | 'agents' | 'board' | 'survey' | 'recall'
export type AgentMuxDesktopFocusTarget =
  | ({ kind: 'space' } & AgentMuxSpaceSelector)
  /** The reference identifies an existing saved item, not a pin or a new membership. */
  | { kind: 'survey'; selection: AgentMuxSurveyPinReference; reference?: Pick<AgentMuxSpaceAddress, 'displayWorkspaceId' | 'groupId' | 'tabId' | 'regionId'> }
  | { kind: 'mote'; spaceId: string; eventId?: string }
  | { kind: 'settings'; sectionId: string | null; hostId?: string }
  | { kind: 'goal'; goalId: string; runtimeId?: string; namespace?: string; section?: 'plan' }
  | { kind: 'focus-agent'; hostId: string; agentSessionId: string }
  | { kind: 'surface'; surface: 'focus'; view?: AgentMuxDesktopFocusView }
  | { kind: 'surface'; surface: Exclude<AgentMuxDesktopSurface, 'focus'> }
export type AgentMuxDesktopInputPolicy = 'preserve' | 'target'
export type AgentMuxDesktopSpaceSelection = {
  spaceId: string | null; zoneId: string | null;
  /** Exact display Workspace; resource context remains on the catalog entity. */
  workspaceId: string
  tabId: string | null; groupId: string | null; regionId: string | null
  topicId: string | null
}
export type AgentMuxDesktopSelection = {
  surface: AgentMuxDesktopSurface; mainSurface: AgentMuxDesktopMainSurface
  focusView: AgentMuxDesktopFocusView | null
  space: AgentMuxDesktopSpaceSelection | null; goalId: string | null
  /** The original Survey choice, independent of retained Work selection. */
  survey?: AgentMuxSurveyPresentation['selection']
}
export type AgentMuxDesktopProvenance = 'observed' | 'unavailable' | 'unknown'
export type AgentMuxDesktopInput = {
  provenance: AgentMuxDesktopProvenance
  scope: 'main' | 'floating' | 'window' | 'overlay' | 'none' | 'unknown'
  /** Native client document identity, when observed; never execution identity. */
  windowId?: string; documentGeneration?: string
  ownerKind: 'terminal' | 'composer' | 'editor' | 'dialog' | 'other' | null
  tabId: string | null; regionId: string | null; sessionId: string | null
  connected: boolean | null; visible: boolean | null; inert: boolean | null
}
export type AgentMuxDesktopPresentation = {
  provenance: AgentMuxDesktopProvenance
  state: 'main-visible' | 'floating' | 'window' | 'covered' | 'pending' | 'unknown'
  windowId?: string; documentGeneration?: string
  tabId: string | null; regionId: string | null
  blockers: ('settings' | 'quick-switcher')[]
  /** Actual client presentation of one original Mote, distinct from the requested target. */
  goal?: { goalId: string; runtimeId: string | null; namespace: string | null; section: 'overview' | 'plan' | 'activity' }
  mote?: { spaceId: string; page: 'discussion' | 'threads'; eventId: string | null }
}
export type AgentMuxDesktopFloating = {
  provenance: AgentMuxDesktopProvenance
  state: 'closed' | 'preview' | 'pinned' | 'unknown'
  topicId: string | null; tabId: string | null; regionId: string | null; sessionId: string | null
  presentation: 'visible' | 'hidden' | 'pending' | 'unknown'
}
export type AgentMuxDesktopSettingsPage = {
  /** Registered IDs come from the mounted client's original Settings catalog. */
  sectionIds: string[]
  /** Actual retained Panel selection, never merely the initial navigation request. */
  sectionId: string | null
  visible: boolean | null
  /** Actual selected Host editor, when that original page supplies the observation. */
  hostId?: string | null
}
export type AgentMuxDesktopOverlays = {
  provenance: AgentMuxDesktopProvenance
  settings: boolean | null; quickSwitcher: boolean | null
  /** Omitted only when the original client has no Settings observation owner. */
  settingsPage?: AgentMuxDesktopSettingsPage | undefined
}
export type AgentMuxDesktopFocusAgent = {
  hostId: string; agentSessionId: string; presentationSessionId: string | null
  state: 'visible' | 'hidden' | 'unconfirmed'
}
export type AgentMuxDesktopObservation = {
  selection: AgentMuxDesktopSelection
  presentation: AgentMuxDesktopPresentation
  input: AgentMuxDesktopInput
  floating: AgentMuxDesktopFloating
  overlays: AgentMuxDesktopOverlays
  focus: { executionSessionId: string | null; pmoSessionId: string | null; agent: AgentMuxDesktopFocusAgent | null }
}
export type AgentMuxDesktopFocusResult = {
  operation: 'focus'
  navigation: {
    state: 'applied' | 'unchanged' | 'rejected' | 'unconfirmed'
    requested: AgentMuxDesktopFocusTarget
    expectedAgentSessionId?: string
    expectedAgentHostId?: string
    selection: AgentMuxDesktopSelection
  }
  presentation: AgentMuxDesktopPresentation
  input: {
    policy: AgentMuxDesktopInputPolicy
    outcome: 'preserved' | 'transferred' | 'unavailable' | 'unconfirmed'
    before: AgentMuxDesktopInput; after: AgentMuxDesktopInput
  }
  floating: AgentMuxDesktopFloating
  overlays: AgentMuxDesktopOverlays
  focus: AgentMuxDesktopObservation['focus']
  partial: boolean
  save: AgentMuxSpatialSave
  issues: AgentMuxSpatialIssue[]
}
