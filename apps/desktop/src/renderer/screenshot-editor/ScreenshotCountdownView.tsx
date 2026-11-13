import { useEffect, useState } from 'react'
import type { ScreenshotCountdownApi } from '../../shared/screenshot-countdown'

/** Shows the seconds Main reports; Main owns the timer, Esc and the start of selection. */
export function ScreenshotCountdownView({ api, initial }: { api: ScreenshotCountdownApi; initial: number }) {
  const [seconds, setSeconds] = useState(initial), [error, setError] = useState<string | null>(null)
  useEffect(() => api.onTick(setSeconds), [api])
  return <main className="screenshot-countdown" aria-live="polite">
    <span className="screenshot-countdown__digit" aria-label={`Capture in ${seconds} seconds`}>{seconds}</span>
    <button type="button" onClick={() => void api.cancel().catch(cause => setError(String(cause)))}>Cancel <kbd>esc</kbd></button>
    {error ? <p role="alert">{error}</p> : null}
  </main>
}
