import { X509Certificate } from 'node:crypto'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxBrowserCertificateRequest } from '@agentmux/core'

export type BrowserCertificateAnswer = {
  requestId: string
  navigationId: string
  fingerprint: string
  allow: boolean
}

/** One original native callback. This is not a certificate trust store. */
export class BrowserCertificateDecision {
  readonly request: AgentMuxBrowserCertificateRequest
  private settled = false

  constructor(input: { url: string; error: string; certificate: string; navigationId: string },
    private readonly current: () => boolean, private readonly complete: (allow: boolean) => void) {
    const url = new URL(input.url)
    if (url.protocol !== 'https:') throw new Error('The original certificate request is not HTTPS.')
    const certificate = new X509Certificate(input.certificate)
    this.request = { requestId: mintObjectId(), navigationId: input.navigationId, url: url.href,
      error: input.error, fingerprint: certificate.fingerprint256, subject: certificate.subject,
      issuer: certificate.issuer, validFrom: certificate.validFrom, validTo: certificate.validTo,
      scope: 'profile-connections' }
  }

  answer(input: BrowserCertificateAnswer): void {
    const request = this.request
    if (!input || typeof input.allow !== 'boolean' || input.requestId !== request.requestId ||
      input.navigationId !== request.navigationId || input.fingerprint !== request.fingerprint ||
      this.settled || !this.current()) {
      throw new Error('This certificate decision no longer matches the original Browser request. Inspect the current page before deciding again.')
    }
    this.settle(input.allow)
  }

  settle(allow: boolean): void {
    if (this.settled) return
    const accepted = allow && this.current()
    this.settled = true
    this.complete(accepted)
  }
}
