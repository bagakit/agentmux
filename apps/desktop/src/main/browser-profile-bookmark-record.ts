import { z } from 'zod'
import { parseBrowserProfileBookmarkReceipt, type BrowserProfileBookmarkReceipt } from '@agentmux/core/control'
const text = z.string().min(1).refine(v => v.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(v))
const folder = z.object({ id: text, parentId: text.nullable(), label: text, revision: text }).strict()
const bookmark = z.object({ id: text, folderId: text.nullable(), title: text, url: text, revision: text }).strict()
const receipt = z.custom<BrowserProfileBookmarkReceipt>(v => { try { parseBrowserProfileBookmarkReceipt(v); return true } catch { return false } })
export const browserProfileBookmarksSchema = z.object({ revision: text, folders: z.array(folder), bookmarks: z.array(bookmark), operations: z.array(receipt) }).strict().superRefine((state, ctx) => {
  const ids = [...state.folders, ...state.bookmarks].map(e => e.id), folders = new Map(state.folders.map(f => [f.id, f]))
  if (new Set(ids).size !== ids.length || new Set(state.operations.map(op => op.operationId)).size !== state.operations.length) ctx.addIssue({ code: 'custom', message: 'Bookmark identities conflict' })
  for (const entry of [...state.folders, ...state.bookmarks]) {
    let parent = 'parentId' in entry ? entry.parentId : entry.folderId
    const visited = new Set([entry.id])
    while (parent !== null) { if (visited.has(parent) || !folders.has(parent)) { ctx.addIssue({ code: 'custom', message: 'Bookmark folder ownership is invalid' }); break } visited.add(parent); parent = folders.get(parent)!.parentId }
  }
})
export type BrowserProfileBookmarksState = z.infer<typeof browserProfileBookmarksSchema>
export const emptyBookmarks = (): BrowserProfileBookmarksState => ({ revision: 'empty', folders: [], bookmarks: [], operations: [] })
