import { Copy } from 'lucide-react'

/** Presentation only: its owner chooses whether Copy uses this URL or refreshes a result. */
export function ToolkitResultLink({ label, url, copy, disabled = false }: { label: string; url: string; copy(url: string): void; disabled?: boolean }) {
  return <div className="toolkit-result__link">
    <button type="button" className="small-button" aria-label={`Copy ${label || 'link'}`} disabled={disabled} onClick={() => copy(url)}><Copy size={13} /> Copy link</button>
    <details>
      <summary>View full link</summary>
      <textarea className="toolkit-result__url" rows={3} readOnly value={url} aria-label={label || 'Connection link'} onFocus={event => event.target.select()} />
    </details>
  </div>
}
