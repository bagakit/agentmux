import { Copy } from 'lucide-react'

/** Presentation only: the owner-provided URL is copied intact, never interpreted as an action. */
export function ToolkitResultLink({ label, url, copy }: { label: string; url: string; copy(url: string): void }) {
  return <div className="toolkit-result__link">
    <button type="button" className="small-button" aria-label={`Copy ${label || 'link'}`} onClick={() => copy(url)}><Copy size={13} /> Copy link</button>
    <details>
      <summary>View full link</summary>
      <textarea className="toolkit-result__url" rows={3} readOnly value={url} aria-label={label || 'Connection link'} onFocus={event => event.target.select()} />
    </details>
  </div>
}
