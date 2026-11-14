import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { FocusTopicPresentation } from '../../../shared/focus-preferences'
import type { FocusZonePresentation } from '../../../shared/focus-zone-presentation'
import { saveFocusPreferences } from '../lib/focus-preferences'
import { useAppStore } from '../store'

type LayoutIntent = { key: string; presentation: FocusTopicPresentation | null; expected: readonly FocusZonePresentation[] }
/** The exact container authors one choice; pending and failed operations keep their original scope. */
export function FocusZoneLayoutToggle({ containerKey, name, presentation, defaultPresentation, unavailable }: {
  containerKey: string | null; name: string; presentation: FocusTopicPresentation; defaultPresentation: FocusTopicPresentation; unavailable?: string
}) {
  const preferences = useAppStore(state => state.config?.focus?.zonePresentations)
  const [attempt, setAttempt] = useState<{ intent: LayoutIntent; token: number; pending: boolean; error?: string } | null>(null)
  const flight = useRef<{ key: string; token: number } | null>(null), generation = useRef(0), live = useRef(true), scope = useRef(containerKey)
  if (scope.current !== containerKey) { scope.current = containerKey; ++generation.current }
  useEffect(() => { live.current = true; return () => { live.current = false; ++generation.current } }, [])
  const current = attempt?.intent.key === containerKey && attempt.token === generation.current ? attempt : null
  async function submit(intent: LayoutIntent) {
    if (flight.current?.key === intent.key || scope.current !== intent.key) return
    const token = ++generation.current
    flight.current = { key: intent.key, token }
    setAttempt({ intent, token, pending: true })
    const next = intent.expected.filter(item => item.key !== intent.key)
    if (intent.presentation !== null) next.push({ key: intent.key, presentation: intent.presentation })
    try {
      await saveFocusPreferences({ zonePresentations: next }, { zonePresentations: intent.expected })
      if (live.current && scope.current === intent.key && generation.current === token) setAttempt(null)
    } catch (cause) {
      if (live.current && scope.current === intent.key && generation.current === token) setAttempt({ intent, token, pending: false, error: presentError(cause) })
    } finally { if (flight.current?.token === token) flight.current = null }
  }
  function choose(value: FocusTopicPresentation | null) {
    if (containerKey) void submit({ key: containerKey, presentation: value, expected: useAppStore.getState().config?.focus?.zonePresentations ?? [] })
  }
  const inherited = !preferences?.some(item => item.key === containerKey)
  return <div className="focus-zone-layout" data-focus-zone-layout="" data-focus-container-key={containerKey ?? undefined} role="group" aria-label={`Zone layout · ${name}`} aria-busy={current?.pending || undefined}>
    {containerKey ? <>
      <div className="focus-zone-layout__modes">{(['sections', 'cards'] as const).map(mode => <button type="button" key={mode} data-focus-zone-presentation={mode}
        aria-label={`${mode === 'sections' ? 'Sections' : 'Tags'} · ${name}`} aria-pressed={presentation === mode} disabled={current?.pending}
        onClick={() => choose(mode)}>{mode === 'sections' ? 'Sections' : 'Tags'}</button>)}</div>
      <button type="button" className="focus-zone-layout__default" aria-label={`Default Zone layout · ${name}`} aria-pressed={inherited}
        title={`Use default · ${defaultPresentation === 'sections' ? 'Sections' : 'Tags'}`} disabled={current?.pending} onClick={() => choose(null)}><SemanticIcon name="action.reset-options" size={12} /></button>
      {current ? <span className="focus-zone-layout__status" role="status">{current.pending ? 'Saving layout…' : <>{current.error} <span>Requested: {current.intent.presentation === null ? 'Default' : current.intent.presentation === 'sections' ? 'Sections' : 'Tags'}.</span>
        <button type="button" onClick={() => void submit(current.intent)}>Retry layout</button>
        <button type="button" onClick={() => setAttempt({ ...current, error: 'Current saved layout reviewed. Retry to apply your requested choice.', intent: { ...current.intent, expected: useAppStore.getState().config?.focus?.zonePresentations ?? [] } })}>Review current layout</button></>}</span> : null}
    </> : <span className="focus-zone-layout__unavailable" role="status" title={unavailable} aria-label={unavailable ?? 'Zone layout needs one confirmed container.'}>Layout unconfirmed</span>}
  </div>
}
