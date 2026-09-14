import { ArrowUpRight, Globe2, Search } from 'lucide-react'
import { useState } from 'react'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { useAppStore } from '../store'

function addressFromInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmed)) return `https://${trimmed}`
  return null
}

export function GlobalSurveySurface() {
  const layouts = useAppStore((state) => state.layouts)
  const selectWorkspace = useAppStore((state) => state.selectWorkspace)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const setMainSurface = useAppStore((state) => state.setMainSurface)
  const reportError = useAppStore((state) => state.reportError)
  const [address, setAddress] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  async function openAddress(): Promise<void> {
    const url = addressFromInput(address)
    if (!url) {
      setMessage('Enter a web address to open in Workspaces.')
      return
    }
    const layout = layouts[SCRATCH_WORKSPACE_ID]
    if (!layout) {
      const error = new Error('Survey needs the durable browser workspace, but it is unavailable.')
      setMessage(error.message)
      reportError(error)
      return
    }
    try {
      selectWorkspace(SCRATCH_WORKSPACE_ID)
      await createBrowser(layout.activeGroupId, undefined, url)
      setMainSurface('workbench')
    } catch (error) {
      setMessage('The browser could not be opened. Your Survey start page is still available.')
      reportError(error)
    }
  }

  return (
    <section className="global-survey-surface" aria-labelledby="survey-title">
      <div className="global-survey-shell">
        <div className="global-survey-mark" aria-hidden="true"><Globe2 size={22} /></div>
        <p className="global-survey-eyebrow">Survey · browse and verify</p>
        <h1 id="survey-title">What are you looking for?</h1>
        <p className="global-survey-copy">Open a page in the durable Browser workspace. Research stays separate from the work you build.</p>
        <form className="global-survey-address" onSubmit={(event) => { event.preventDefault(); void openAddress() }}>
          <Search size={16} aria-hidden="true" />
          <input
            autoFocus
            value={address}
            onChange={(event) => { setAddress(event.target.value); setMessage(null) }}
            placeholder="Search or enter a web address"
            aria-label="Search or enter a web address"
            inputMode="url"
          />
          <button type="submit" aria-label="Open address" title="Open in Workspaces"><ArrowUpRight size={16} /></button>
        </form>
        {message ? <p className="global-survey-message" role="status">{message}</p> : null}
        <p className="global-survey-hint">Use a full URL, such as <code>https://example.com</code>.</p>
      </div>
    </section>
  )
}
