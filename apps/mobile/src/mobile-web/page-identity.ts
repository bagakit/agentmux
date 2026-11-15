import { mintObjectId } from '@agentmux/core/object-id'
import { mobilePageNamespaceDigest } from '@agentmux/core/mobile-web-codec'

export type MobileWebPageIdentity = Readonly<{ documentId: string; buildId: string | null; namespaceDigest: string | null }>
let page: MobileWebPageIdentity | undefined

/** A reconnect or menu change keeps the build recorded in this document. */
export function mobileWebPageIdentity(): MobileWebPageIdentity {
  if (!page) {
    const buildId = typeof document === 'undefined' ? null
      : document.querySelector<HTMLMetaElement>('meta[name="agentmux-mobile-build"]')?.content || null
    // The Host redirects to this immutable resource namespace. This is this document's
    // original URL, never the manifest currently served by a later active snapshot.
    const namespaceDigest = typeof location === 'undefined' ? null : mobilePageNamespaceDigest(location.pathname, buildId)
    page = Object.freeze({ documentId: mintObjectId(), buildId, namespaceDigest })
  }
  return page
}
