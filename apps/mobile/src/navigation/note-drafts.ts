import type { FileWriteReceipt } from '@agentmux/core/files'
import { acknowledgeNoteWrite, type NoteEditState } from '@agentmux/client-ui/note/note-edit-state'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'

const observers = new Map<string, Set<(raw: string, durable?: boolean) => void>>()
const latest = new Map<string, string>()
const pending = new Map<string, number>()
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
  const key = 'agentmux-mobile-note-draft:' + JSON.stringify(identity)
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
