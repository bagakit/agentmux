export { mergeLiveNote, type NoteLiveMerge } from '@agentmux/client-ui/note/note-live-merge'

/** Live composition capabilities only; document bytes remain in the original File session. */
const composing = new Map<string, Set<string>>()
const completions = new Map<string, Set<() => void>>()
export function setNoteComposition(key: string, view: string, active: boolean): void {
  const views = composing.get(key) ?? new Set<string>()
  if (active) { views.add(view); composing.set(key, views); return }
  views.delete(view)
  if (views.size) return
  composing.delete(key)
  const pending = completions.get(key); completions.delete(key)
  pending?.forEach(complete => complete())
}
export async function afterNoteComposition(key: string): Promise<void> {
  while (composing.get(key)?.size) await new Promise<void>(resolve => {
    const pending = completions.get(key) ?? new Set<() => void>(); pending.add(resolve); completions.set(key, pending)
  })
}
