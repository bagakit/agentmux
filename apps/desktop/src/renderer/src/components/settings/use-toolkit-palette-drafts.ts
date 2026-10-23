import { useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { TerminalThemeId } from '../../../../shared/contracts'
import { saveToolkitPalette, useAppStore } from '../../store'

type Palette = TerminalThemeId | null
type Draft = { value: Palette; expected: Palette; saved: Palette; state: 'idle' | 'saving' | 'saved' | 'error'; error: string }
export type ToolkitPaletteDraft = Draft & { dirty: boolean; change(value: Palette): void; reset(): void }

/** Drafts share the tool library's lifetime; only explicit Save reaches the existing preference writer. */
export function useToolkitPaletteDrafts() {
  const saved = useAppStore(state => state.toolkitPresentation)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const pending = useRef(new Set<string>())
  const dirty = (id: string) => Boolean(drafts[id] && (drafts[id]!.value !== drafts[id]!.expected || drafts[id]!.state === 'error'))
  const forget = (id: string) => setDrafts(previous => {
    const next = { ...previous }; delete next[id]; return next
  })
  const reset = (id: string) => setDrafts(previous => {
    const draft = previous[id]
    if (!draft) return previous
    const current = useAppStore.getState().toolkitPresentation[id]?.theme ?? null
    // Explicit restore may adopt another writer's current preference. A failed
    // own write still restores the last confirmed value, then requires Save.
    const restored = current === draft.expected ? draft.saved : current
    return { ...previous, [id]: { ...draft, value: restored, expected: current, saved: restored } }
  })
  function forTool(id: string): ToolkitPaletteDraft {
    const baseline = saved[id]?.theme ?? null
    const retained = drafts[id]
    const draft = retained && (dirty(id) || retained.state === 'saving') ? retained
      : { value: baseline, expected: baseline, saved: baseline, state: retained?.state ?? 'idle', error: '' }
    return { ...draft, dirty: dirty(id), reset: () => reset(id), change: value => setDrafts(previous => {
      const original = previous[id]
      const keep = original && (original.value !== original.expected || original.state === 'error' || original.state === 'saving')
      return { ...previous, [id]: { value, expected: keep ? original.expected : baseline, saved: keep ? original.saved : baseline,
        state: pending.current.has(id) ? 'saving' : original?.state === 'error' ? 'error' : 'idle', error: original?.error ?? '' } }
    }) }
  }
  async function save(id: string): Promise<boolean> {
    const captured = drafts[id]
    if (!captured || !dirty(id)) return true
    if (pending.current.has(id)) return false
    pending.current.add(id)
    setDrafts(previous => ({ ...previous, [id]: { ...previous[id]!, state: 'saving', error: '' } }))
    try {
      await saveToolkitPalette(id, captured.value, captured.expected)
      setDrafts(previous => previous[id] ? { ...previous, [id]: { ...previous[id]!, expected: captured.value, saved: captured.value,
        state: previous[id]!.value === captured.value ? 'saved' : 'idle', error: '' } } : previous)
      return true
    } catch (cause) {
      const applied = useAppStore.getState().toolkitPresentation[id]?.theme ?? null
      setDrafts(previous => previous[id] ? { ...previous, [id]: { ...previous[id]!,
        expected: applied === captured.value ? captured.value : previous[id]!.expected,
        state: 'error', error: presentError(cause) } } : previous)
      return false
    } finally { pending.current.delete(id) }
  }
  return { forTool, dirty, save, reset, forget }
}
