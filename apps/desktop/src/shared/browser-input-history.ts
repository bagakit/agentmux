/** Main resolves resource Workspace and confirmed Profile, never presentation Workspace. */
export type BrowserInputHistoryTarget =
  | { kind: 'browser'; browserId: string; profileId: string | null }
  | { kind: 'workspace'; workspaceId: string }

export type BrowserInputHistoryScope = { workspaceId: string; profileId: string | null }
/** Real last-seen document artwork; the original submitted text remains the input identity. */
export type BrowserInputHistoryAppearance = { url: string; title: string; faviconDataUrl?: string | undefined }
export type BrowserInputHistoryEntry = { text: string; submittedAt: number; appearance?: BrowserInputHistoryAppearance | undefined }
export type BrowserInputHistorySnapshot = {
  scope: BrowserInputHistoryScope
  entries: BrowserInputHistoryEntry[]
}
export type BrowserInputHistoryRecord = BrowserInputHistorySnapshot & {
  outcome: 'recorded' | 'empty' | 'url-userinfo' | 'private'
}
