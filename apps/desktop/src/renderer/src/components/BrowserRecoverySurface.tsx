import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { BrowserRecoveryPreviewReadResult } from '../../../shared/browser-recovery-preview'

const BrowserIcon = semanticIconComponent('object.browser')
const RefreshIcon = semanticIconComponent('action.refresh')
const CopyIcon = semanticIconComponent('action.copy')
const SavedIcon = semanticIconComponent('status.saved')
const WarningIcon = semanticIconComponent('status.warning')
const LoadingIcon = semanticIconComponent('status.loading')
const ChevronIcon = semanticIconComponent('navigation.submenu')

/** Presentation only. The caller retains the original page and recovery operation. */
export function BrowserRecoverySurface({ url, title, faviconDataUrl, heading, description, error, busy, restoring,
  preview, retryLabel = 'Retry', onRetry, onEditAddress, onCopy }: {
  url: string
  title: string
  faviconDataUrl?: string | undefined
  heading: string
  description: string
  error?: string | null | undefined
  busy: boolean
  restoring?: boolean | undefined
  preview?: BrowserRecoveryPreviewReadResult | undefined
  retryLabel?: string | undefined
  onRetry?: (() => void) | undefined
  onEditAddress(): void
  onCopy(text: string): Promise<boolean>
}) {
  const [copyResult, setCopyResult] = useState<{ url: string; successful: boolean } | null>(null)
  const [failedFavicon, setFailedFavicon] = useState<string | null>(null)
  const [failedPreview, setFailedPreview] = useState<string | null>(null)
  const previous = preview?.status === 'available' ? preview.preview : null
  const previousImage = previous?.image.dataUrl
  const currentCopy = copyResult?.url === url ? copyResult : null
  let origin = ''
  try { origin = new URL(url).host } catch { /* The exact address remains readable and copyable. */ }
  const pageTitle = previous && previous.url !== url ? origin || 'Browser page'
    : previous?.title.trim() || title.trim() || origin || 'Browser page'

  async function copyAddress(): Promise<void> {
    const successful = await onCopy(url)
    setCopyResult({ url, successful })
  }

  return <section className="browser-recovery" aria-label="Browser recovery">
    <div className="browser-recovery__body">
      <header className="browser-recovery__identity">
        <span className="browser-recovery__icon" aria-hidden="true">
          {faviconDataUrl && faviconDataUrl !== failedFavicon
            ? <img src={faviconDataUrl} alt="" onError={() => setFailedFavicon(faviconDataUrl)} />
            : <BrowserIcon size={25} />}
        </span>
        <div><span className="browser-recovery__eyebrow">Browser</span>
          <h2>{pageTitle}</h2>
          {origin && origin !== pageTitle ? <p>{origin}</p> : null}
        </div>
      </header>
      <div className="browser-recovery__address">
        <code title={url}>{url}</code>
        <button type="button" className="icon-button" aria-label="Copy page address"
          title={currentCopy?.successful ? 'Address copied' : 'Copy page address'} onClick={() => void copyAddress()}>
          {currentCopy?.successful ? <SavedIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      </div>
      {currentCopy ? <p className="browser-recovery__copy-result" role="status">
        {currentCopy.successful ? 'Address copied' : 'Address could not be copied. You can select it in the address bar.'}
      </p> : null}
      <div className="browser-recovery__message" role="status" aria-live="polite">
        <span className="browser-recovery__state-icon" aria-hidden="true">
          {restoring ? <LoadingIcon size={16} animation="spin" /> : <WarningIcon size={16} />}
        </span>
        <div><h3>{heading}</h3><p>{description}</p></div>
      </div>
      <div className="browser-recovery__actions">
        {onRetry ? <button className="primary-button" type="button" disabled={busy || restoring}
          aria-busy={busy || restoring} onClick={onRetry}>
          {busy || restoring ? <LoadingIcon size={13} animation="spin" /> : <RefreshIcon size={13} />}
          {retryLabel}
        </button> : null}
        <button className="small-button" type="button" onClick={onEditAddress}>Edit address</button>
      </div>
      {previous && previousImage && failedPreview !== previousImage ? <figure className="browser-recovery__preview">
        <img src={previousImage} alt="Previously viewed page" width={previous.image.width} height={previous.image.height}
          onError={() => setFailedPreview(previousImage)} />
        <figcaption><span>Previous preview · not live</span>
          <strong>{previous.title.trim() || previous.url}</strong>
          {previous.url !== url ? <code title={previous.url}>{previous.url}</code> : null}
        </figcaption>
      </figure> : null}
      {preview?.warning || (previousImage && failedPreview === previousImage) ?
        <p className="browser-recovery__preview-notice" role="status">{preview?.warning || 'The previous preview could not be displayed. Retry and address editing remain available.'}</p> : null}
      {error ? <details className="browser-recovery__details">
        <summary><ChevronIcon size={12} />Technical details</summary>
        <pre>{error}</pre>
      </details> : null}
    </div>
  </section>
}
