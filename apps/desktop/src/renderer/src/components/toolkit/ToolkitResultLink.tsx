import { Textarea } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import { isSystemWebUrl } from '../../../../shared/system-web-url'
import { useAppStore } from '../../store'

const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')

type SurveyOpening = { phase: 'idle' | 'opening' | 'opened' | 'unconfirmed' | 'failed'; message: string }

/**
 * Open an http(s) Toolkit link in Survey through the one Survey open-by-URL owner. Each press is a new
 * explicit Browser; an unconfirmed opening keeps its message and is never replayed automatically.
 */
export function useOpenInSurvey(url: string) {
  const openUrlInSurvey = useAppStore(state => state.openUrlInSurvey)
  const [result, setResult] = useState<SurveyOpening & { url: string }>({ url, phase: 'idle', message: '' })
  const opening: SurveyOpening = result.url === url ? result : { phase: 'idle', message: '' }
  // A ref, not state: two presses in the same tick both see the stale state before React re-renders.
  const inFlight = useRef<{ url: string } | null>(null)
  const available = isSystemWebUrl(url)
  async function open() {
    if (!available || inFlight.current?.url === url) return
    const request = { url }
    inFlight.current = request
    const publish = (opening: SurveyOpening) => { if (inFlight.current === request) setResult({ ...opening, url }) }
    publish({ phase: 'opening', message: '' })
    try {
      const outcome = await openUrlInSurvey(url)
      publish(outcome.state === 'opened' ? { phase: 'opened', message: 'Opened in Survey.' } : { phase: 'unconfirmed', message: outcome.message })
    } catch (error) { publish({ phase: 'failed', message: presentError(error) }) }
    finally { if (inFlight.current === request) inFlight.current = null }
  }
  return { available, opening, open }
}

export function OpenInSurveyButton({ url, className = 'small-button', note }: { url: string; className?: string; note?: string | undefined }) {
  const { available, opening, open } = useOpenInSurvey(url)
  if (!available) return null
  return <>
    <button type="button" className={className} disabled={opening.phase === 'opening'} title={note} onClick={() => { void open() }}>
      <ThemeObjectBrowserIcon size={13} aria-hidden="true" /> {opening.phase === 'opening' ? 'Opening…' : 'Open in Survey'}</button>
    {opening.message ? <p className="toolkit-result__survey-feedback" role={opening.phase === 'opened' ? 'status' : 'alert'}>{opening.message}</p> : null}
  </>
}

/** Presentation only: its owner chooses whether Copy uses this URL or refreshes a result. */
export function ToolkitResultLink({ label, url, copy, disabled = false }: { label: string; url: string; copy(url: string): void; disabled?: boolean }) {
  return <div className="toolkit-result__link">
    <Button type="button" aria-label={`Copy ${label || 'link'}`} disabled={disabled} onClick={() => copy(url)}><ThemeActionCopyIcon size={13} /> Copy link</Button>
    {!disabled ? <OpenInSurveyButton url={url} /> : null}
    <details>
      <summary>View full link</summary>
      <Textarea className="toolkit-result__url" rows={3} readOnly value={url} aria-label={label || 'Connection link'} onFocus={event => event.target.select()} />
    </details>
  </div>
}
