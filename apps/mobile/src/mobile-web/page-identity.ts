import { mintObjectId } from '@agentmux/core/object-id'
import { mobilePageNamespaceDigest } from '@agentmux/core/mobile-web-codec'

declare const __AGENTMUX_MOBILE_BUILD_ID__: string | undefined

export type MobileWebPageIdentity = Readonly<{ documentId: string; buildId: string | null; namespaceDigest: string | null }>
let page: MobileWebPageIdentity | undefined

/** A reconnect or menu change keeps this document and its originally compiled build. */
export function mobileWebPageIdentity(): MobileWebPageIdentity {
  if (!page) {
    const buildId = typeof __AGENTMUX_MOBILE_BUILD_ID__ === 'string' && __AGENTMUX_MOBILE_BUILD_ID__
      ? __AGENTMUX_MOBILE_BUILD_ID__ : null
    // The Host redirects to this immutable resource namespace. This is this document's
    // original URL, never the manifest currently served by a later active snapshot.
    const namespaceDigest = typeof location === 'undefined' ? null : mobilePageNamespaceDigest(location.pathname, buildId)
    page = Object.freeze({ documentId: mintObjectId(), buildId, namespaceDigest })
  }
  return page
}
