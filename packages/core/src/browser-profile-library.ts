import { AgentMuxError } from './errors.js'
import type { BrowserProfileControlProfile, BrowserProfileFolder } from './browser-profile-control.js'

/** A query describes current facts. It never holds an actionable selection. */
export type BrowserProfileQuery = {
  search?: string
  folderId?: string | null
  tag?: string
  status?: 'running' | 'idle' | 'unknown'
  route?: 'system' | 'direct' | 'proxy'
  lastUsed?: 'day' | 'week' | 'month' | 'unknown'
  sort?: 'name' | 'recent' | 'observed-time'
}
export type BrowserProfileView = { id: string; label: string; query: BrowserProfileQuery }
export type BrowserProfileSelectionItem = { profileId: string; expectedRevision: string }
export type BrowserProfileBulkAction = { kind: 'pin'; pinned: boolean } | { kind: 'move'; folderId: string | null }
  | { kind: 'add-tag' | 'remove-tag'; tag: string }
export type BrowserProfileBulkItemResult = BrowserProfileSelectionItem & (
  { outcome: 'updated'; profile: BrowserProfileControlProfile } | { outcome: 'failed'; code: string; message: string })

function invalid(message: string, code: string): never { throw new AgentMuxError(message, code) }
function object(value: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) invalid('Profile library data contains an unsupported field.', code)
  return value as Record<string, unknown>
}
function name(value: unknown, code: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) invalid('A nonempty Profile library name is required within its supported length.', code)
  return value.trim().normalize('NFC')
}
function id(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512 || /[\s\0]/u.test(value)) invalid('An exact Profile library identity or configuration token is required.', code)
  return value
}
export function parseBrowserProfileQuery(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProfileQuery {
  const row = object(value, ['search', 'folderId', 'tag', 'status', 'route', 'lastUsed', 'sort'], code)
  const result: BrowserProfileQuery = {}
  if (row.search !== undefined) {
    if (typeof row.search !== 'string' || row.search.length > 2000) invalid('Profile search must be text of at most 2000 characters.', code)
    if (row.search.trim()) result.search = row.search.trim()
  }
  if (row.folderId !== undefined) result.folderId = row.folderId === null ? null : id(row.folderId, code)
  if (row.tag !== undefined) result.tag = name(row.tag, code)
  for (const [key, allowed] of Object.entries({ status: ['running', 'idle', 'unknown'], route: ['system', 'direct', 'proxy'],
    lastUsed: ['day', 'week', 'month', 'unknown'], sort: ['name', 'recent', 'observed-time'] })) {
    if (row[key] === undefined) continue
    if (!allowed.includes(row[key] as string)) invalid(`Unsupported Profile ${key}.`, code)
    Object.assign(result, { [key]: row[key] })
  }
  return result
}
export function parseBrowserProfileView(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProfileView {
  const row = object(value, ['id', 'label', 'query'], code)
  return { id: id(row.id, code), label: name(row.label, code), query: parseBrowserProfileQuery(row.query, code) }
}
export function parseBrowserProfileSelection(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProfileSelectionItem[] {
  if (!Array.isArray(value) || !value.length) invalid('Select at least one exact Profile before applying a bulk change.', code)
  const items = value.map(item => {
    const row = object(item, ['profileId', 'expectedRevision'], code)
    return { profileId: id(row.profileId, code), expectedRevision: id(row.expectedRevision, code) }
  })
  if (new Set(items.map(item => item.profileId)).size !== items.length) invalid('A Profile may appear only once in a bulk selection.', code)
  return items
}
export function parseBrowserProfileBulkAction(value: unknown, code = 'INVALID_CONTROL_REQUEST'): BrowserProfileBulkAction {
  const row = object(value, ['kind', 'pinned', 'folderId', 'tag'], code)
  switch (row.kind) {
    case 'pin':
      if (typeof row.pinned !== 'boolean' || 'folderId' in row || 'tag' in row) invalid('Pin changes require only pinned: true or false.', code)
      return { kind: 'pin', pinned: row.pinned }
    case 'move':
      if ('pinned' in row || 'tag' in row) invalid('Move changes require only an exact folder ID or null.', code)
      return { kind: 'move', folderId: row.folderId === null ? null : id(row.folderId, code) }
    case 'add-tag': case 'remove-tag':
      if ('pinned' in row || 'folderId' in row) invalid('Tag changes require only a tag name.', code)
      return { kind: row.kind, tag: name(row.tag, code) }
    default: return invalid('Bulk Profile changes support pin, move, add-tag or remove-tag only.', code)
  }
}

const collator = new Intl.Collator(undefined, { numeric: true })
/** Pure projection shared by Main/public queries and the original Settings list. No native acquisition. */
export function queryBrowserProfiles<T extends Pick<BrowserProfileControlProfile, 'id' | 'label' | 'createdAt' | 'notes' | 'source' | 'tags' | 'folderId' | 'pinned' | 'network' | 'activity'>>(
  profiles: readonly T[], folders: readonly BrowserProfileFolder[], query: BrowserProfileQuery, evaluatedAt: number
): T[] {
  if (!Number.isSafeInteger(evaluatedAt) || evaluatedAt < 0) invalid('Profile query time is unavailable.', 'BROWSER_PROFILE_QUERY_TIME_UNAVAILABLE')
  if (query.folderId && !folders.some(folder => folder.id === query.folderId)) invalid('This view names a folder that is no longer available. Edit its folder scope; the original view and Profiles are kept.', 'BROWSER_PROFILE_VIEW_SCOPE_UNAVAILABLE')
  const needle = query.search?.toLocaleLowerCase(), folderNames = new Map(folders.map(folder => [folder.id, folder.label]))
  const lastUse = (profile: T) => profile.activity && profile.activity.lastUsedAt <= evaluatedAt ? profile.activity.lastUsedAt : undefined
  const filtered = profiles.filter(profile => {
    if (query.folderId !== undefined && (profile.folderId ?? null) !== query.folderId) return false
    if (query.tag !== undefined && !profile.tags?.includes(query.tag)) return false
    if (query.status !== undefined && (profile.activity?.state ?? 'unknown') !== query.status) return false
    if (query.route !== undefined && (profile.network?.mode ?? 'system') !== query.route) return false
    if (query.lastUsed === 'unknown' && lastUse(profile) !== undefined) return false
    if (query.lastUsed && query.lastUsed !== 'unknown') {
      const at = lastUse(profile), days = query.lastUsed === 'day' ? 1 : query.lastUsed === 'week' ? 7 : 30
      if (at === undefined || evaluatedAt - at > days * 86_400_000) return false
    }
    return !needle || [profile.label, profile.notes ?? '', profile.source?.browserLabel ?? '', profile.source?.profileLabel ?? '',
      ...(profile.tags ?? []), folderNames.get(profile.folderId ?? '') ?? ''].some(text => text.toLocaleLowerCase().includes(needle))
  })
  const descendingKnown = (a: number | undefined, b: number | undefined) => a === undefined ? b === undefined ? 0 : 1 : b === undefined ? -1 : b - a
  return filtered.sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) ||
    (query.sort === 'name' ? collator.compare(a.label, b.label) : query.sort === 'recent' ? descendingKnown(lastUse(a), lastUse(b)) :
      query.sort === 'observed-time' ? descendingKnown(a.activity?.observedRunMs, b.activity?.observedRunMs) : 0))
}
