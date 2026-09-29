import type { AgentMuxSpaceSelector, AgentMuxSpatialIssue, AgentMuxSpatialSave } from './space-control.js'

/** Client presentation facts. Core neither owns nor initializes a desktop surface. */
export type AgentMuxDesktopSurface = 'space' | 'focus' | 'goals' | 'survey'
export type AgentMuxDesktopMainSurface = 'workbench' | 'agents' | 'board' | 'survey'
export type AgentMuxDesktopFocusTarget =
  | ({ kind: 'space' } & AgentMuxSpaceSelector)
  | { kind: 'goal'; goalId: string }
  | { kind: 'surface'; surface: AgentMuxDesktopSurface }
export type AgentMuxDesktopInputPolicy = 'preserve' | 'target'
export type AgentMuxDesktopSpaceSelection = {
  spaceId: string; zoneId: string; workspaceId: string
  tabId: string | null; groupId: string | null; regionId: string | null
  topicId: string | null
}
export type AgentMuxDesktopSelection = {
  surface: AgentMuxDesktopSurface; mainSurface: AgentMuxDesktopMainSurface
  space: AgentMuxDesktopSpaceSelection | null; goalId: string | null
}
export type AgentMuxDesktopProvenance = 'observed' | 'unavailable' | 'unknown'
export type AgentMuxDesktopInput = {
  provenance: AgentMuxDesktopProvenance
  scope: 'main' | 'floating' | 'overlay' | 'none' | 'unknown'
  ownerKind: 'terminal' | 'composer' | 'editor' | 'dialog' | 'other' | null
  tabId: string | null; regionId: string | null; sessionId: string | null
  connected: boolean | null; visible: boolean | null; inert: boolean | null
}
export type AgentMuxDesktopPresentation = {
  provenance: AgentMuxDesktopProvenance
  state: 'main-visible' | 'floating' | 'covered' | 'pending' | 'unknown'
  tabId: string | null; regionId: string | null
  blockers: ('settings' | 'quick-switcher')[]
}
export type AgentMuxDesktopFloating = {
  provenance: AgentMuxDesktopProvenance
  state: 'closed' | 'preview' | 'pinned' | 'unknown'
  topicId: string | null; tabId: string | null; regionId: string | null; sessionId: string | null
  presentation: 'visible' | 'hidden' | 'pending' | 'unknown'
}
export type AgentMuxDesktopOverlays = {
  provenance: AgentMuxDesktopProvenance
  settings: boolean | null; quickSwitcher: boolean | null
}
export type AgentMuxDesktopObservation = {
  selection: AgentMuxDesktopSelection
  presentation: AgentMuxDesktopPresentation
  input: AgentMuxDesktopInput
  floating: AgentMuxDesktopFloating
  overlays: AgentMuxDesktopOverlays
  focus: { executionSessionId: string | null; pmoSessionId: string | null }
}
export type AgentMuxDesktopFocusResult = {
  operation: 'focus'
  navigation: {
    state: 'applied' | 'unchanged' | 'rejected' | 'unconfirmed'
    requested: AgentMuxDesktopFocusTarget
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
