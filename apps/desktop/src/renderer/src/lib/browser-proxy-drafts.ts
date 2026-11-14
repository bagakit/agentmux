import { desktopUserFragments } from './desktop-user-state'

export type ProxyLibraryDraft = { assetId: string | null; baseRevision: string | null; label: string; server: string; bypass: string; notes: string }
type DraftRecord = { active: ProxyLibraryDraft | null; retained: ProxyLibraryDraft[] }
type Document = { schema: 'agentmux.proxy-library-drafts.v1'; assets: Record<string, DraftRecord> }
const member = 'browserProxyLibraryDrafts' as const
export const proxyDraftId = (draft: ProxyLibraryDraft) => draft.assetId ?? 'new'
export const proxyDraftKey = (draft: ProxyLibraryDraft) => JSON.stringify([draft.assetId, draft.baseRevision, draft.label, draft.server, draft.bypass, draft.notes])
function draft(value: unknown): ProxyLibraryDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The original proxy draft is unreadable. Its bytes are retained.')
  const row = value as Record<string, unknown>, names = ['assetId', 'baseRevision', 'label', 'server', 'bypass', 'notes']
  if (Object.keys(row).length !== names.length || Object.keys(row).some(name => !names.includes(name)) ||
      !names.every(name => typeof row[name] === 'string' || (['assetId', 'baseRevision'].includes(name) && row[name] === null)))
    throw new Error('The original proxy draft is unreadable. Its bytes are retained.')
  return value as ProxyLibraryDraft
}
function parse(raw: string | null | undefined): Document {
  if (raw == null) return { schema: 'agentmux.proxy-library-drafts.v1', assets: {} }
  const value = JSON.parse(raw)
  if (value?.schema !== 'agentmux.proxy-library-drafts.v1' || !value.assets || typeof value.assets !== 'object' || Array.isArray(value.assets) || Object.keys(value).some(key => !['schema', 'assets'].includes(key)))
    throw new Error('The original proxy drafts could not be read. Their bytes are retained.')
  for (const [id, record] of Object.entries(value.assets) as [string, DraftRecord][]) {
    if (!record || typeof record !== 'object' || Object.keys(record).some(key => !['active', 'retained'].includes(key)) || !Array.isArray(record.retained)) throw new Error('The original proxy draft records are unreadable. Their bytes are retained.')
    if (record.active !== null && proxyDraftId(draft(record.active)) !== id) throw new Error('The proxy draft belongs to another asset. Its bytes are retained.')
    for (const retained of record.retained) if (proxyDraftId(draft(retained)) !== id) throw new Error('The earlier proxy draft belongs to another asset. Its bytes are retained.')
  }
  return value
}
/** Client input on the original Desktop document; no route, credential or native application owner. */
export const browserProxyDrafts = {
  async load() { await desktopUserFragments.load(member, parse) },
  get(id: string): DraftRecord | undefined { return structuredClone(parse(desktopUserFragments.read(member)).assets[id]) },
  write(value: ProxyLibraryDraft, retain?: ProxyLibraryDraft) {
    // A pasted sign-in remains editable in memory; it never enters this non-secret draft member.
    if (value.server.includes('@') || retain?.server.includes('@')) throw new Error('The server draft contains a sign-in and has not been saved to disk. Remove it here and use the Profile sign-in fields.')
    const document = parse(desktopUserFragments.read(member)), id = proxyDraftId(value), previous = document.assets[id], retained = previous?.retained ?? []
    if (retain && proxyDraftKey(retain) !== proxyDraftKey(value) && !retained.some(old => proxyDraftKey(old) === proxyDraftKey(retain))) retained.push(retain)
    document.assets[id] = { active: structuredClone(value), retained }
    desktopUserFragments.write(member, JSON.stringify(document))
  },
  retainActive(id: string) {
    const document = parse(desktopUserFragments.read(member)), record = document.assets[id]
    if (!record?.active) return
    if (!record.retained.some(value => proxyDraftKey(value) === proxyDraftKey(record.active!))) record.retained.push(record.active)
    record.active = null
    desktopUserFragments.write(member, JSON.stringify(document))
  },
  clearSubmitted(value: ProxyLibraryDraft) {
    const document = parse(desktopUserFragments.read(member)), id = proxyDraftId(value), record = document.assets[id]
    if (!record?.active || proxyDraftKey(record.active) !== proxyDraftKey(value)) return
    if (record.retained.length) record.active = null
    else delete document.assets[id]
    desktopUserFragments.write(member, JSON.stringify(document))
  },
  restore(id: string): ProxyLibraryDraft {
    const document = parse(desktopUserFragments.read(member)), record = document.assets[id]
    if (!record?.retained.length) throw new Error('No earlier proxy draft is available. Refresh the original draft storage.')
    const value = record.retained.shift()!
    if (record.active) record.retained.push(record.active)
    record.active = value
    desktopUserFragments.write(member, JSON.stringify(document))
    return structuredClone(value)
  },
  async checkpoint() { await desktopUserFragments.checkpoint(member) }
}
