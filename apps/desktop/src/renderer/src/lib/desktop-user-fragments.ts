import type { BrowserProfileTextDrafts } from './browser-profile-text-drafts'

/** Closed Desktop-private document members, never filesystem or public RPC keys. */
export const DESKTOP_FRAGMENT_KEYS = {
  browserProfileCreations: 'agentmux.browser-profile-creations.v1',
  browserProfileTextDrafts: 'agentmux.browser-profile-text-drafts.v1',
  browserProxyLibraryDrafts: 'agentmux.browser-proxy-library-drafts.v1',
  launcher: 'agentmux-launcher',
  agentBookmarks: 'agentmux.agent-bookmarks.v1',
  moteFloating: 'agentmux.leader-topic-floating.v1',
  moteAvatarSaveDrafts: 'agentmux.mote-avatar-save-draft.v1:',
  globalGoalPatrolOperation: 'agentmux.global-goal-patrol.operation.v1',
  profileEnvironmentDrafts: 'agentmux.browser-profile-environment-drafts.v1'
} as const
export type DesktopFragmentValues = {
  browserProfileCreations: string | null
  browserProfileTextDrafts: BrowserProfileTextDrafts | null
  browserProxyLibraryDrafts: string | null
  launcher: string | null
  agentBookmarks: string | null
  moteFloating: string | null
  moteAvatarSaveDrafts: Record<string, string>
  globalGoalPatrolOperation: string | null
  profileEnvironmentDrafts: string | null
}
export type DesktopFragmentName = keyof DesktopFragmentValues
