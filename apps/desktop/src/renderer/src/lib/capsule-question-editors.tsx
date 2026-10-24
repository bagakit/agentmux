import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { parseCapsuleRpcParams, type CapsuleInteraction, type CapsuleParamsMap } from '@agentmux/core/capsule'

export type CapsuleQuestionAttempt = ({ method: 'capsule.interaction.draft'; params: CapsuleParamsMap['capsule.interaction.draft'] } |
  { method: 'capsule.interaction.reply'; params: CapsuleParamsMap['capsule.interaction.reply'] }) & { pending: boolean }
/** Editable bytes and an observation handle only. Capsule/Core still own all request and input facts. */
export type CapsuleQuestionEditor = {
  answer: string; baseline: { value: string; revision: number }; attempt: CapsuleQuestionAttempt | null; autoSave: boolean; notice: string
}
export type CapsuleQuestionEditorPort = {
  get(key: string): CapsuleQuestionEditor | undefined
  compareAndSwap(key: string, expected: CapsuleQuestionEditor | undefined, value: CapsuleQuestionEditor | undefined): boolean
  subscribe(changed: () => void): () => void
  flush(): Promise<void>
}
export const CapsuleQuestionEditorsContext = createContext<CapsuleQuestionEditorPort | null>(null)
// A persisted pending handle does not claim that its old JavaScript promise still exists.
const liveAttempts = new WeakSet<CapsuleQuestionAttempt>()
export function observeCapsuleQuestionAttempt<T>(attempt: CapsuleQuestionAttempt, work: () => Promise<T>): Promise<T> {
  liveAttempts.add(attempt)
  return Promise.resolve().then(work).finally(() => liveAttempts.delete(attempt))
}
export function capsuleQuestionEditorKey(browserId: string, capsuleId: string, interactionId: string): string {
  return JSON.stringify([browserId, capsuleId, interactionId])
}
export function restoredCapsuleQuestionEditors(editors: Record<string, CapsuleQuestionEditor> | undefined): Record<string, CapsuleQuestionEditor> {
  return Object.fromEntries(Object.entries(editors ?? {}).map(([key, editor]) => [key, editor && typeof editor === 'object'
    ? { ...editor, autoSave: false, ...(editor.attempt ? { attempt: { ...editor.attempt, pending: false } } : {}) } : editor]))
}
function validate(editor: CapsuleQuestionEditor, capsuleId: string, interactionId: string): void {
  if (!editor || typeof editor.answer !== 'string' || typeof editor.notice !== 'string' || typeof editor.autoSave !== 'boolean' ||
    typeof editor.baseline?.value !== 'string' || !Number.isSafeInteger(editor.baseline.revision) || editor.baseline.revision < 0) throw new Error('The original retained page answer is unreadable. Its stored bytes have been kept.')
  if (editor.attempt) {
    if (typeof editor.attempt.pending !== 'boolean' || !['capsule.interaction.draft', 'capsule.interaction.reply'].includes(editor.attempt.method)) throw new Error('The original page answer operation is unreadable. It has not been replaced.')
    const params = parseCapsuleRpcParams(editor.attempt.method, editor.attempt.params)
    if (params.capsuleId !== capsuleId || params.interactionId !== interactionId) throw new Error('The retained page answer belongs to another original question. It has not been applied.')
  }
}
const noSubscription = () => () => {}

/** The host's original workbench writer keeps edits beyond one mounted card. */
export function useCapsuleQuestionEditor(browserId: string | undefined, interaction: CapsuleInteraction) {
  const host = useContext(CapsuleQuestionEditorsContext)
  const port = browserId ? host : null
  const key = browserId ? capsuleQuestionEditorKey(browserId, interaction.capsuleId, interaction.interactionId) : ''
  const [local, setLocal] = useState<CapsuleQuestionEditor>()
  const localRef = useRef(local); localRef.current = local
  const initial = useMemo<CapsuleQuestionEditor>(() => ({ answer: interaction.answer ?? interaction.draft,
    baseline: { value: interaction.answer ?? interaction.draft, revision: interaction.revision }, attempt: null, autoSave: true, notice: '' }),
  [interaction.answer, interaction.draft, interaction.revision])
  const fallback = useRef(initial); fallback.current = initial
  const saved = useSyncExternalStore(port?.subscribe ?? noSubscription, useCallback(() => port?.get(key), [port, key]), () => undefined)
  const readStored = useCallback(() => port ? port.get(key) : localRef.current, [port, key])
  const read = useCallback(() => readStored() ?? fallback.current, [readStored])
  const update = useCallback((change: (current: CapsuleQuestionEditor) => CapsuleQuestionEditor | undefined): boolean => {
    const expected = readStored(), next = change(expected ?? fallback.current)
    if (next === expected) return false
    if (port) return port.compareAndSwap(key, expected, next)
    localRef.current = next; setLocal(next); return true
  }, [port, key, readStored])
  let issue = ''
  const retained = port ? saved : local
  try { if (retained !== undefined) validate(retained, interaction.capsuleId, interaction.interactionId) } catch (error) { issue = String(error) }
  const editor = issue ? { ...initial, answer: typeof retained?.answer === 'string' ? retained.answer : initial.answer, autoSave: false } : retained ?? initial
  const retainedOperationId = issue && typeof retained?.attempt?.params?.operationId === 'string' ? retained.attempt.params.operationId : undefined
  // Mount is an observation, never a reason to resume an old automatic save or send.
  useLayoutEffect(() => {
    if (!retained || issue) return
    update(current => ({ ...current, autoSave: false, attempt: current.attempt && !liveAttempts.has(current.attempt)
      ? { ...current.attempt, pending: false } : current.attempt }))
  }, [key, port])
  useLayoutEffect(() => {
    if (!retained || issue || retained.attempt || retained.notice || retained.answer !== retained.baseline.value ||
        interaction.revision < retained.baseline.revision) return
    update(current => current === retained ? undefined : current)
  }, [retained, issue, interaction.revision, update])
  const flush = useCallback(() => port?.flush() ?? Promise.resolve(), [port])
  return { editor, issue, retainedOperationId, read, update, flush }
}
