/** Main resolves resource Workspace and confirmed Profile, never presentation Workspace. */
export type BrowserInputHistoryTarget =
  | { kind: 'browser'; browserId: string; profileId: string }
  | { kind: 'workspace'; workspaceId: string }

export type BrowserInputHistoryScope = { workspaceId: string; profileId: string }
export type BrowserInputHistoryEntry = { text: string; submittedAt: number }
export type BrowserInputHistorySnapshot = {
  scope: BrowserInputHistoryScope
  entries: BrowserInputHistoryEntry[]
}
export type BrowserInputHistoryRecord = BrowserInputHistorySnapshot & {
  outcome: 'recorded' | 'empty' | 'url-userinfo'
}
