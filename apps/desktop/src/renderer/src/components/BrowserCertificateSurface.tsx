import { useState } from 'react'
import type { AgentMuxBrowserCertificateRequest } from '@agentmux/core'
import { semanticIconComponent } from '@agentmux/client-ui/icons'

const WarningIcon = semanticIconComponent('status.warning')

export function BrowserCertificateSurface({ request, privateMode, containerMode, onAnswer }: {
  request: AgentMuxBrowserCertificateRequest
  privateMode: boolean
  containerMode: boolean
  onAnswer(allow: boolean): Promise<void>
}) {
  const scope = privateMode ? 'temporary session' : containerMode ? 'container' : 'profile'
  const [answering, setAnswering] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  async function answer(allow: boolean): Promise<void> {
    if (answering) return
    setAnswering(true)
    setFailure(null)
    try { await onAnswer(allow) }
    catch { setFailure('The original certificate decision could not be confirmed. Check this page before trying again.') }
    finally { setAnswering(false) }
  }
  return <section className="browser-recovery browser-certificate" aria-label="Server certificate decision">
    <div className="browser-recovery__body">
      <header className="browser-recovery__identity">
        <span className="browser-recovery__icon" aria-hidden="true"><WarningIcon size={25} /></span>
        <div><span className="browser-recovery__eyebrow">Connection security</span>
          <h2>Certificate needs your review</h2></div>
      </header>
      <p className="browser-certificate__intro">The server’s identity could not be verified. Check the address and certificate before continuing.</p>
      <div className="browser-recovery__address"><code title={request.url}>{request.url}</code></div>
      <p className="browser-certificate__error">{request.error}</p>
      <dl className="browser-certificate__facts">
        <div><dt>SHA256 fingerprint</dt><dd><code>{request.fingerprint}</code></dd></div>
      </dl>
      <details className="browser-recovery__details browser-certificate__details">
        <summary>Certificate details</summary>
        <dl className="browser-certificate__facts">
          <div><dt>Subject</dt><dd>{request.subject || 'Not provided'}</dd></div>
          <div><dt>Issuer</dt><dd>{request.issuer || 'Not provided'}</dd></div>
          <div><dt>Valid from</dt><dd>{request.validFrom}</dd></div>
          <div><dt>Valid until</dt><dd>{request.validTo}</dd></div>
        </dl>
      </details>
      <div className="browser-certificate__scope">
        <strong>{privateMode ? 'Temporary browsing session' : containerMode ? 'Browser container' : 'Browser profile'} scope</strong>
        <p>Other pages in this {scope} may reuse the accepted connection. Continuing is not limited to this page.</p>
        <p>No system trust is changed or permanent certificate exception saved.</p>
      </div>
      {failure ? <p className="browser-certificate__failure" role="alert">{failure}</p> : null}
      <div className="browser-recovery__actions browser-certificate__actions">
        <button type="button" className="primary-button" disabled={answering}
          onClick={event => { if (event.isTrusted) void answer(false) }}>Keep blocked</button>
        <button type="button" className="small-button" disabled={answering}
          onClick={event => { if (event.isTrusted) void answer(true) }}>Continue to site</button>
      </div>
    </div>
  </section>
}
