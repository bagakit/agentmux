import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { resolveFocusMapMotion } from '../../../shared/focus-preferences'
import { useAppStore } from '../store'
import { saveFocusPreferences } from './focus-preferences'
import { useWorkbenchDocument } from './workbench-document'
import { useWorkbenchDocumentVisibility } from './workbench-window-registry'

/** Presentation only: the original activity owner continues observing and expiring events. */
export function useCollaborationMotion(active: boolean) {
  const preference = useAppStore(state => resolveFocusMapMotion(state.config?.focus?.mapMotion))
  const document = useWorkbenchDocument()
  const visible = useWorkbenchDocumentVisibility(document)
  const reduced = useMemo(() => document.defaultView!.matchMedia('(prefers-reduced-motion: reduce)'), [document])
  const subscribe = useCallback((changed: () => void) => {
    if (!active || !visible || preference !== 'system') return () => {}
    reduced.addEventListener('change', changed)
    return () => reduced.removeEventListener('change', changed)
  }, [active, visible, preference, reduced])
  const enabled = useSyncExternalStore(subscribe,
    () => active && visible && (preference === 'on' || preference === 'system' && !reduced.matches))
  const pending = useRef(false)
  const [saving, setSaving] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  const setEnabled = useCallback(async (on: boolean): Promise<void> => {
    if (pending.current) return
    pending.current = true; setSaving(true); setIssue(null)
    try { await saveFocusPreferences({ mapMotion: on ? 'on' : 'off' }, { mapMotion: preference }) }
    catch (cause) { setIssue(presentError(cause)) }
    finally { pending.current = false; setSaving(false) }
  }, [preference])
  return { enabled, preference, setEnabled, saving, issue }
}
