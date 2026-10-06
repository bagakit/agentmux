import type { FileWriteReceipt } from '@agentmux/core/files'
import { acknowledgeNoteWrite, type NoteEditState } from '@agentmux/client-ui/note/note-edit-state'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { convertLegacyNoteDraft } from '@agentmux/client-ui/note/note-legacy-draft'
import type { NotesResourceChange } from '@agentmux/core/notebook-store'
import type { FileReadResource } from '@agentmux/core/files'

const observers = new Map<string, Set<(raw: string, durable?: boolean) => void>>()
const latest = new Map<string, string>()
const pending = new Map<string, number>()
const prefix = 'agentmux-mobile-note-draft:'
export const noteDraftResourceIdentity = (resource: FileReadResource) => [resource.hostId, resource.workspaceId, resource.workspacePath, resource.zoneId, resource.zonePath, resource.path, resource.logicalDirectory ?? null]
function parse(raw: string): NoteEditState {
  const value = JSON.parse(raw) as NoteEditState
  const note = readNoteDocument(value.draft)
  const revision = (value: unknown) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
  if (note.status !== 'valid' || note.note.noteId !== value.noteId || !revision(value.expectedRevision)
    || value.alternates !== undefined && (!Array.isArray(value.alternates) || value.alternates.some(item => typeof item.draft !== 'string' || !revision(item.expectedRevision)))
    || value.unconfirmed !== undefined && (!Array.isArray(value.unconfirmed) || value.unconfirmed.some(item => typeof item.content !== 'string' || !revision(item.expectedRevision)))
    || value.attempt && (typeof value.attempt.content !== 'string' || !revision(value.attempt.expectedRevision) || !['sending', 'unknown'].includes(value.attempt.phase))) throw new Error('原设备草稿无法完整读取')
  return value
}
/** Device-owned draft and unresolved save intent, never a filesystem truth or write queue. */
export function noteDrafts(identity: readonly string[]) {
  const key = prefix + JSON.stringify(identity)
  let observed: string | null = null, inspected: string | null = null
  let initial: NoteEditState | undefined, issue = '', readable = true
  const listener = (raw: string, durable = true) => { if (durable) observed = raw; for (const callback of callbacks) callback(parse(raw)) }
  const callbacks = new Set<(value: NoteEditState) => void>()
  const current = (raw: string): NoteEditState => {
    const value = parse(raw)
    return value.attempt && !pending.get(key) ? { ...value, attempt: { ...value.attempt, phase: 'unknown' } } : value
  }
  try {
    observed = localStorage.getItem(key)
    if (observed !== null) { initial = current(observed); latest.set(key, observed) }
  } catch (error) { readable = false; issue = `${error instanceof Error ? error.message : String(error)}；原存储未覆盖，当前仍可编辑。` }
  function save(value: NoteEditState) {
    if (!readable) throw new Error(issue)
    try {
      if (localStorage.getItem(key) !== observed) throw new Error('另一工作面已保存较新的本机草稿；请核对本机笔记草稿，保全两份后明确采用')
      const raw = JSON.stringify(value)
      localStorage.setItem(key, raw); observed = raw; latest.set(key, raw)
      for (const observer of observers.get(key) ?? []) if (observer !== listener) observer(raw)
    } catch (error) { throw new Error(`本机笔记草稿保存失败：${error instanceof Error ? error.message : String(error)}；当前草稿仍保留。`) }
  }
  return {
    initial, issue, save,
    /** Exact owner receipts re-key the original device draft; original records remain backups. */
    restoreRelocated(resource: FileReadResource, noteId: string, changes: readonly NotesResourceChange[], bodyRevision: string) {
      const origins: { resource: NotesResourceChange['from']; conversion?: NotesResourceChange['conversion'] }[] = []
      let cursor = { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath, path: resource.path }
      let conversion: NotesResourceChange['conversion']
      for (const change of [...changes].reverse()) if (change.noteId === noteId && (['hostId', 'workspaceId', 'workspacePath', 'path'] as const).every(field => change.to[field] === cursor[field])) {
        cursor = change.from; conversion = change.conversion ?? conversion
        origins.push({ resource: cursor, ...(conversion ? { conversion } : {}) })
      }
      if (conversion) for (const origin of origins) origin.conversion ??= conversion
      const matches: { key: string; raw: string; origin: typeof origins[number] }[] = []
      for (let index = 0; index < localStorage.length; index++) {
        const candidateKey = localStorage.key(index)
        if (!candidateKey?.startsWith(prefix) || candidateKey === key) continue
        let address: unknown, owner: unknown
        try { address = JSON.parse(candidateKey.slice(prefix.length)); owner = Array.isArray(address) && typeof address[0] === 'string' ? JSON.parse(address[0]) : null } catch { continue }
        if (!Array.isArray(address) || address[1] !== noteId || !Array.isArray(owner) || owner.length !== 7 || owner[3] !== resource.zoneId) continue
        const origin = origins.find(({ resource: from }) => owner[0] === from.hostId && owner[1] === from.workspaceId && owner[2] === from.workspacePath && owner[5] === from.path)
        if (origin) { const raw = localStorage.getItem(candidateKey); if (raw !== null) matches.push({ key: candidateKey, raw, origin }) }
      }
      if (!matches.length) return false
      if (matches.length > 1) throw new Error('原设备存在多个准确资源草稿；全部保留，请先核对原工作面，未自动选择或覆盖')
      const match = matches[0]!, legacy = JSON.parse(match.raw) as NoteEditState
      const converted = convertLegacyNoteDraft(legacy.draft, noteId)
      if (legacy.noteId !== noteId || converted.status === 'unconfirmed') throw new Error(converted.status === 'unconfirmed' ? converted.message : '原设备草稿Note身份不匹配')
      if (converted.status === 'converted' && !match.origin.conversion) throw new Error('原格式转换回执尚未确认；旧设备草稿保留，未自动改写')
      const retained = parse(JSON.stringify({ ...legacy, draft: converted.content }))
      const originalDraft = { draft: legacy.draft, expectedRevision: legacy.expectedRevision }
      let next: NoteEditState = { ...retained, ...(retained.attempt ? { attempt: { ...retained.attempt, phase: 'unknown' } } : {}),
        ...(converted.status === 'converted' ? { alternates: [...retained.alternates ?? [], originalDraft] } : {}) }
      if (!next.attempt && match.origin.conversion && next.expectedRevision === match.origin.conversion.sourceRevision && bodyRevision === match.origin.conversion.targetRevision) next.expectedRevision = bodyRevision
      const currentRaw = localStorage.getItem(key)
      if (currentRaw !== observed || localStorage.getItem(match.key) !== match.raw) throw new Error('原设备草稿在转换观察期间改变，两份均保留；请刷新核对')
      if (currentRaw !== null) {
        const current = parse(currentRaw), alternates = [...current.alternates ?? []], unconfirmed = [...current.unconfirmed ?? []]
        for (const draft of [{ draft: next.draft, expectedRevision: next.expectedRevision }, ...next.alternates ?? []]) {
          if (draft.draft !== current.draft && !alternates.some(other => other.draft === draft.draft && other.expectedRevision === draft.expectedRevision)) alternates.push(draft)
        }
        for (const attempt of [...next.unconfirmed ?? [], ...next.attempt ? [next.attempt] : []]) {
          if (!unconfirmed.some(other => other.content === attempt.content && other.expectedRevision === attempt.expectedRevision)) unconfirmed.push({ content: attempt.content, expectedRevision: attempt.expectedRevision })
        }
        next = { ...current, alternates, unconfirmed }
      }
      save(next)
      for (const callback of callbacks) callback(next)
      return true
    },
    subscribe(callback: (value: NoteEditState) => void) {
      callbacks.add(callback)
      if (!observers.has(key)) observers.set(key, new Set())
      observers.get(key)!.add(listener)
      return () => { callbacks.delete(callback); if (!callbacks.size) { observers.get(key)?.delete(listener); if (!observers.get(key)?.size) observers.delete(key) } }
    },
    async send(content: string, expectedRevision: string, write: () => Promise<FileWriteReceipt>): Promise<FileWriteReceipt> {
      pending.set(key, (pending.get(key) ?? 0) + 1)
      try {
        let result: FileWriteReceipt
        try { result = await write() } catch (error) { result = { status: 'unknown', code: 'NOTE_SAVE_UNKNOWN', message: error instanceof Error ? error.message : String(error) } }
        let raw: string | null, durable = true
        try { raw = localStorage.getItem(key) } catch { raw = latest.get(key) ?? observed; durable = false }
        const value = raw === null ? undefined : parse(raw)
        if (value?.attempt?.content === content && value.attempt.expectedRevision === expectedRevision) {
          const next = result.status === 'written' ? acknowledgeNoteWrite(value, content, expectedRevision, result)
            : { ...value, attempt: result.status === 'unknown' ? { ...value.attempt, phase: 'unknown' as const } : undefined }
          const written = JSON.stringify(next)
          if (durable) { try { localStorage.setItem(key, written); observed = written; latest.set(key, written) } catch { durable = false } }
          for (const observer of observers.get(key) ?? []) observer(durable ? written : JSON.stringify({ ...value, attempt: { ...value.attempt, phase: 'unknown' } }), durable)
        }
        return result
      }
      finally { const count = pending.get(key)! - 1; if (count) pending.set(key, count); else pending.delete(key) }
    },
    readDevice() { inspected = localStorage.getItem(key); return inspected === null ? undefined : current(inspected) },
    adoptDevice(value: NoteEditState) {
      if (localStorage.getItem(key) !== inspected) throw new Error('本机草稿又有更新，请重新核对；两份草稿保留')
      if (inspected !== null) parse(inspected)
      readable = true; observed = inspected; save(value)
    }
  }
}
