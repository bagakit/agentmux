import '../browser-profiles-settings/entry'
import { api } from '../../../src/renderer/src/lib/api'
import type { BrowserProfileBookmarkList, BrowserProfileBookmarkReceipt } from '@agentmux/core/control'
// Production Settings/Profile editor and bookmark component, with explicit fixture owner DTOs only.
// Public owner persistence/opening/restart are verified by the separate native fixture.
const counts = { reads: 0, edits: 0, opens: 0, imports: 0, exports: 0, checked: [] as string[] }
let unknown = false, refused = false, lastOperation = '', title = 'Reading list — release notes', address = 'https://docs.example.test/release?edition=2#compatibility'
const record = (operationId: string, kind: BrowserProfileBookmarkReceipt['kind'], extra = {}): BrowserProfileBookmarkReceipt => ({ operationId, kind, expectedRevision: 'library-original-revision', status: 'completed', createdIds: [], conflicts: [], ...extra })
api.browser.listProfileBookmarks = async (profileId, folderId, operationId) => {
  counts.reads++; if (operationId) counts.checked.push(operationId)
  return { profileId, folderId, revision: 'library-original-revision', ancestors: folderId ? [{ id: folderId, parentId: null, label: 'Research & reference', revision: 'folder-original' }] : [],
    folders: folderId ? [] : [{ id: 'reference-folder', parentId: null, label: 'Research & reference', revision: 'folder-original' }],
    bookmarks: [{ id: 'original-reading', folderId, title, url: address, revision: 'entry-original' }, { id: 'long-reading', folderId, title: 'Accessibility guidance and keyboard navigation', url: 'https://reference.example.test/interface/keyboard-navigation?platform=desktop#focus-order', revision: 'entry-second' }],
    pending: [record('original-pending-open-id', 'open', { status: 'pending', folderId, entryId: 'older-bookmark', browserId: 'original-other-browser', entryRevision: 'older-entry-revision' })], ...(operationId ? { receipt: operationId === lastOperation ? record(operationId, 'edit', { entryId: 'original-reading' }) : null } : {}) } satisfies BrowserProfileBookmarkList
}
api.browser.listTargets = async () => ({ coverage: 'complete', targets: [{ id: 'exact-profile-browser', workspaceId: null, source: 'embedded', status: 'ready', title: 'Reading workspace', url: 'https://docs.example.test/', capabilities: [], profile: { id: (await api.browser.readProfiles()).profiles[0]!.id, label: 'Personal' } }] })
api.browser.editProfileBookmark = async (profileId, _revision, operationId, change) => {
  counts.edits++; lastOperation = operationId
  if (refused) throw Object.assign(new Error('This bookmark address is invalid. Its original input is kept.'), { code: 'BROWSER_PROFILE_BOOKMARK_REFUSED' })
  if (unknown) throw new Error('The reply was lost after dispatch. Original operation is retained.')
  if (change.kind === 'save') { title = change.title; if (change.url !== undefined) address = change.url }
  return { profileId, revision: 'library-original-revision', receipt: record(operationId, 'edit', { entryId: 'original-reading' }) }
}
api.browser.openProfileBookmark = async (profileId, bookmarkId, browserId, _revision, operationId) => { counts.opens++; return { profileId, revision: 'library-original-revision', receipt: record(operationId, 'open', { entryId: bookmarkId, browserId, entryRevision: 'entry-original' }) } }
Object.assign(window, { bookmarksVisual: { counts, unknown: () => { unknown = true }, refused: () => { unknown = false; refused = true }, get lastOperation() { return lastOperation } } })
