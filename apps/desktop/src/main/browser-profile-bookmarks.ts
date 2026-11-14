import { classifyBrowserTarget } from './browser-app-link.js'
import { BrowserProfileBookmarkRefused } from './browser-profile-bookmark-open.js'
import { dirname } from 'node:path'
import { readFile, open } from 'node:fs/promises'
import { parse } from 'parse5'
import { runProcess } from '@agentmux/core'
import { AgentMuxError, parseBrowserProfileBookmarkChange, type BrowserProfileBookmarkChange, type BrowserProfileBookmarkList, type BrowserProfileBookmarkMutation, type BrowserProfileBookmarkReceipt, type BrowserProfileBookmarkConflict } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { bookmarkKindForPath } from '../shared/bookmark-file.js'
import { readBookmark } from './bookmark-file.js'
import { type BrowserProfileBookmarksState } from './browser-profile-bookmark-record.js'

type Ports = { read(profileId: string): Promise<BrowserProfileBookmarksState>; change(profileId: string, action: (state: BrowserProfileBookmarksState) => BrowserProfileBookmarksState, durable?: boolean): Promise<BrowserProfileBookmarksState> }
type Imported = { kind: 'folder'; label: string; children: Imported[] } | { kind: 'bookmark'; title: string; url: string }
const error = (message: string, code = 'INVALID_CONTROL_REQUEST'): never => { throw new AgentMuxError(message, code) }
const exactFolder = (state: BrowserProfileBookmarksState, id: string | null) => { if (id !== null && !state.folders.some(f => f.id === id)) return error('The exact bookmark folder is unavailable. Read the original Profile library again.') }
const revision = (state: BrowserProfileBookmarksState, expected: string) => { if (state.revision !== expected) return error('This bookmark library changed. Read its original revision before editing; your inputs remain available.', 'BROWSER_PROFILE_REVISION_CONFLICT') }
function notAdmitted<T>(action: () => T): T {
  try { return action() } catch (cause) {
    if (cause instanceof AgentMuxError && cause.code !== 'BROWSER_PROFILE_BOOKMARK_ALREADY_ADMITTED') throw new AgentMuxError(cause.message, 'BROWSER_PROFILE_BOOKMARK_REFUSED')
    throw cause
  }
}
const original = (state: BrowserProfileBookmarksState, operationId: string) => { if (!operationId.trim() || /[\u0000-\u001f\u007f]/u.test(operationId)) return error('The original bookmark operation identity is invalid.'); if (state.operations.some(op => op.operationId === operationId)) return error('This original bookmark operation already has an intent or receipt. Inspect it by operationId; it will not be replayed.', 'BROWSER_PROFILE_BOOKMARK_ALREADY_ADMITTED') }
/** Keep the full original URI, including query and fragment. Errors never echo it. */
function address(value: string): string {
  try { new URL(value); if (value !== 'about:blank' && classifyBrowserTarget(value).kind === 'refuse') return error('The original Browser owner does not support this bookmark address.'); return value }
  catch (cause) { if (cause instanceof AgentMuxError) throw cause; return error('This bookmark address is invalid. Its original input is kept.') }
}
const ack = (operationId: string, expectedRevision: string, kind: BrowserProfileBookmarkReceipt['kind'], extra: Partial<BrowserProfileBookmarkReceipt> = {}): BrowserProfileBookmarkReceipt => ({ operationId, expectedRevision, kind, status: 'completed', createdIds: [], conflicts: [], ...extra })
const result = (profileId: string, state: BrowserProfileBookmarksState, operationId: string): BrowserProfileBookmarkMutation => ({ profileId, revision: state.revision, receipt: structuredClone(state.operations.find(op => op.operationId === operationId)!) })
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

type HtmlNode = { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] }
const content = (node: HtmlNode): string => node.value ?? (node.childNodes ?? []).map(content).join('')
function importedHtml(html: string): Imported[] {
  const root = parse(html) as unknown as HtmlNode
  const find = (node: HtmlNode, tag: string): HtmlNode | undefined => node.nodeName === tag ? node : node.childNodes?.map(c => find(c, tag)).find(Boolean)
  const dl = find(root, 'dl'); if (!dl) return error('The source has no Netscape bookmark list. The original library is kept.')
  function list(node: HtmlNode): Imported[] {
    const values: Imported[] = []
    for (const child of node.childNodes ?? []) {
      if (child.nodeName === 'dt') {
        const h = child.childNodes?.find(n => n.nodeName === 'h3'), a = child.childNodes?.find(n => n.nodeName === 'a'), nested = child.childNodes?.find(n => n.nodeName === 'dl')
        if (h) values.push({ kind: 'folder', label: content(h), children: nested ? list(nested) : [] })
        else if (a) values.push({ kind: 'bookmark', title: content(a), url: a.attrs?.find(v => v.name === 'href')?.value ?? '' })
      } else if (child.nodeName === 'dl') { const previous = values.at(-1); if (previous?.kind === 'folder') previous.children.push(...list(child)); else values.push(...list(child)) }
    }
    return values
  }
  return list(dl)
}
function exportHtml(state: BrowserProfileBookmarksState, folderId: string | null): string {
  function list(id: string | null, indent: string): string {
    return indent + '<DL><p>\n' + state.folders.filter(f => f.parentId === id).map(f => indent + `  <DT><H3>${xml(f.label)}</H3>\n` + list(f.id, indent + '  ')).join('')
      + state.bookmarks.filter(b => b.folderId === id).map(b => indent + `  <DT><A HREF="${xml(b.url)}">${xml(b.title)}</A>\n`).join('') + indent + '</DL><p>\n'
  }
  return '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n' + list(folderId, '')
}

/** The original Profile metadata is the only library and operation owner. No session starts on reads. */
export class BrowserProfileBookmarks {
  constructor(private readonly ports: Ports) {}
  async list(profileId: string, folderId: string | null, operationId?: string): Promise<BrowserProfileBookmarkList> {
    const state = await this.ports.read(profileId); exactFolder(state, folderId)
    const ancestors = []; let parent = folderId
    while (parent !== null) { const folder = state.folders.find(f => f.id === parent)!; ancestors.unshift(structuredClone(folder)); parent = folder.parentId }
    return { profileId, revision: state.revision, folderId, ancestors, folders: structuredClone(state.folders.filter(f => f.parentId === folderId)), bookmarks: structuredClone(state.bookmarks.filter(b => b.folderId === folderId)), pending: structuredClone(state.operations.filter(op => op.status === 'pending')),
      ...(operationId === undefined ? {} : { receipt: structuredClone(state.operations.find(op => op.operationId === operationId) ?? null) }) }
  }
  async edit(profileId: string, expectedRevision: string, operationId: string, raw: BrowserProfileBookmarkChange): Promise<BrowserProfileBookmarkMutation> {
    const state = await this.ports.change(profileId, state => notAdmitted(() => {
      original(state, operationId); const change = parseBrowserProfileBookmarkChange(raw); revision(state, expectedRevision)
      const receipt = ack(operationId, expectedRevision, 'edit')
      const folder = (id: string) => state.folders.find(f => f.id === id) ?? error('The exact bookmark folder is unavailable.')
      if (change.kind === 'create-folder') { exactFolder(state, change.parentId); const id = mintObjectId(); state.folders.push({ id, parentId: change.parentId, label: change.label, revision: mintObjectId() }); receipt.createdIds.push(id); receipt.entryId = id }
      else if (change.kind === 'rename-folder') { const f = folder(change.id); f.label = change.label; f.revision = mintObjectId(); receipt.entryId = f.id }
      else if (change.kind === 'move-folder') { const f = folder(change.id); exactFolder(state, change.parentId); let parent = change.parentId; while (parent !== null) { if (parent === f.id) return error('A bookmark folder cannot be moved into itself or its descendants.'); parent = folder(parent).parentId } f.parentId = change.parentId; f.revision = mintObjectId(); receipt.entryId = f.id }
      else if (change.kind === 'remove-folder') { folder(change.id); if (state.folders.some(f => f.parentId === change.id) || state.bookmarks.some(b => b.folderId === change.id)) return error('This folder still contains bookmarks or folders. Move or remove those exact entries first.'); state.folders = state.folders.filter(f => f.id !== change.id); receipt.entryId = change.id }
      else if (change.kind === 'remove') { if (!state.bookmarks.some(b => b.id === change.id)) return error('The exact bookmark is unavailable.'); state.bookmarks = state.bookmarks.filter(b => b.id !== change.id); receipt.entryId = change.id }
      else {
        exactFolder(state, change.folderId)
        const existing = change.id === undefined ? undefined : state.bookmarks.find(b => b.id === change.id) ?? error('The exact bookmark is unavailable.')
        const url = change.url === undefined ? existing!.url : address(change.url)
        if (state.bookmarks.some(b => b.id !== existing?.id && b.folderId === change.folderId && b.url === url)) return error('This exact address already exists in that folder. The original bookmark is kept.')
        if (existing) { existing.title = change.title; existing.folderId = change.folderId; existing.url = url; existing.revision = mintObjectId(); receipt.entryId = existing.id }
        else { const id = mintObjectId(); state.bookmarks.push({ id, folderId: change.folderId, title: change.title, url, revision: mintObjectId() }); receipt.entryId = id; receipt.createdIds.push(id) }
      }
      state.revision = mintObjectId(); state.operations.push(receipt); return state
    })); return result(profileId, state, operationId)
  }
  async import(profileId: string, folderId: string | null, expectedRevision: string, operationId: string, sourcePath: string): Promise<BrowserProfileBookmarkMutation> {
    let values: Imported[] = [], sourceFailure: string | undefined
    try {
      const bytes = await readFile(sourcePath), kind = bookmarkKindForPath(sourcePath)
      if (kind) { const parsed = await readBookmark(kind, bytes, runProcess); values = [{ kind: 'bookmark', title: 'Imported bookmark', url: parsed.url ?? '' }] }
      else values = importedHtml(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (cause) { sourceFailure = cause instanceof AgentMuxError ? cause.message : 'The bookmark source could not be read. Its path and content are kept private; the original library is unchanged.' }
    const state = await this.ports.change(profileId, state => notAdmitted(() => {
      original(state, operationId); if (sourceFailure) return error(sourceFailure); revision(state, expectedRevision); exactFolder(state, folderId)
      const receipt = ack(operationId, expectedRevision, 'import', { folderId }); let index = 0
      const add = (items: Imported[], parentId: string | null) => {
        for (const item of items) {
          const sourceIndex = index++
          if (item.kind === 'folder') {
            if (!item.label.trim() || /[\u0000-\u001f\u007f]/u.test(item.label)) { receipt.conflicts.push({ index: sourceIndex, reason: 'invalid-entry' }); continue }
            const id = mintObjectId(); state.folders.push({ id, parentId, label: item.label, revision: mintObjectId() }); receipt.createdIds.push(id); add(item.children, id)
          } else {
            let url: string; try { url = address(item.url) } catch { receipt.conflicts.push({ index: sourceIndex, reason: 'unsupported-address' }); continue }
            if (!item.title.trim() || /[\u0000-\u001f\u007f]/u.test(item.title)) { receipt.conflicts.push({ index: sourceIndex, reason: 'invalid-entry' }); continue }
            if (state.bookmarks.some(b => b.folderId === parentId && b.url === url)) { receipt.conflicts.push({ index: sourceIndex, reason: 'duplicate' }); continue }
            const id = mintObjectId(); state.bookmarks.push({ id, folderId: parentId, title: item.title, url, revision: mintObjectId() }); receipt.createdIds.push(id)
          }
        }
      }
      add(values, folderId); if (receipt.createdIds.length) state.revision = mintObjectId(); state.operations.push(receipt); return state
    })); return result(profileId, state, operationId)
  }
  private async begin(profileId: string, expectedRevision: string, receipt: BrowserProfileBookmarkReceipt, select: (state: BrowserProfileBookmarksState) => void): Promise<BrowserProfileBookmarksState> {
    return this.ports.change(profileId, state => notAdmitted(() => { original(state, receipt.operationId); revision(state, expectedRevision); select(state); state.operations.push({ ...receipt, status: 'pending' }); return state }), true)
  }
  private async finish(profileId: string, operationId: string, status: 'completed' | 'failed', warning?: string): Promise<BrowserProfileBookmarkMutation> {
    const state = await this.ports.change(profileId, state => { const receipt = state.operations.find(op => op.operationId === operationId); if (!receipt || receipt.status !== 'pending') return error('The original bookmark dispatch intent is unavailable.'); receipt.status = status; if (warning) receipt.warning = warning; return state }, true)
    return result(profileId, state, operationId)
  }
  async export(profileId: string, folderId: string | null, expectedRevision: string, operationId: string, destinationPath: string): Promise<BrowserProfileBookmarkMutation> {
    let html = ''
    await this.begin(profileId, expectedRevision, ack(operationId, expectedRevision, 'export', { folderId }), state => { exactFolder(state, folderId); html = exportHtml(state, folderId) })
    try { const file = await open(destinationPath, 'wx', 0o600); try { await file.writeFile(html, 'utf8'); await file.sync() } finally { await file.close() } const directory = await open(dirname(destinationPath), 'r'); try { await directory.sync() } finally { await directory.close() } }
    catch { return this.finish(profileId, operationId, 'failed', 'The new export file could not be fully confirmed. An existing file was not overwritten; inspect the original destination before another explicit action.') }
    return this.finish(profileId, operationId, 'completed')
  }
  async open(profileId: string, bookmarkId: string, browserId: string, expectedRevision: string, operationId: string, dispatch: (url: string) => Promise<void>): Promise<BrowserProfileBookmarkMutation> {
    let url = ''
    const receipt = ack(operationId, expectedRevision, 'open', { entryId: bookmarkId, browserId })
    await this.begin(profileId, expectedRevision, receipt, state => { const bookmark = state.bookmarks.find(b => b.id === bookmarkId); if (!bookmark) return error('The exact bookmark is unavailable.'); url = address(bookmark.url); receipt.entryRevision = bookmark.revision; receipt.folderId = bookmark.folderId })
    // Native failure may follow actual page effects. Keep the durable original pending receipt; never replay.
    try { await dispatch(url) } catch (cause) {
      if (cause instanceof BrowserProfileBookmarkRefused) return this.finish(profileId, operationId, 'failed', cause.message)
      return result(profileId, await this.ports.read(profileId), operationId)
    }
    return this.finish(profileId, operationId, 'completed')
  }
}
