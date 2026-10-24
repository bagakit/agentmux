import { mintObjectId } from '@agentmux/core/object-id'

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
    const parts = typeof location === 'undefined' ? [] : location.pathname.split('/')
    const namespaceDigest = buildId && parts.length === 5 && parts[1] === 'mobile' && parts[2] === encodeURIComponent(buildId)
      && /^[a-f0-9]{64}$/u.test(parts[3]!) && parts[4] === 'index.html' ? 'sha256:' + parts[3] : null
    page = Object.freeze({ documentId: mintObjectId(), buildId, namespaceDigest })
  }
  return page
}
