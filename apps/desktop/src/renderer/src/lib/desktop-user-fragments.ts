/** Closed Desktop-private document members, never filesystem or public RPC keys. */
export const DESKTOP_FRAGMENT_KEYS = {
  launcher: 'agentmux-launcher',
  agentBookmarks: 'agentmux.agent-bookmarks.v1',
  moteFloating: 'agentmux.leader-topic-floating.v1',
  moteAvatarSaveDrafts: 'agentmux.mote-avatar-save-draft.v1:',
  globalGoalPatrolOperation: 'agentmux.global-goal-patrol.operation.v1'
} as const
export type DesktopFragmentValues = {
  launcher: string | null
  agentBookmarks: string | null
  moteFloating: string | null
  moteAvatarSaveDrafts: Record<string, string>
  globalGoalPatrolOperation: string | null
}
export type DesktopFragmentName = keyof DesktopFragmentValues
