import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core'
import { isSystemWebUrl, type SystemWebUrlRequest } from '../shared/system-web-url.js'
import type { SpatialLinkIngress } from './spatial-link-ingress.js'
import { SystemPageIngress } from './system-page-ingress.js'

/** Only genuine HTTP(S) URLs enter this owner. OS files have a separate input. */
export class WebUrlIngress extends SystemPageIngress<SystemWebUrlRequest> {
  receive(url: string): void {
    if (!isSystemWebUrl(url)) this.issue('This system link is not a valid HTTP(S) URL. Existing pages and drafts are kept.')
    else this.enqueue({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'browser.openFromSystem', url })
  }
}

/** amux keeps its original object-navigation semantics; ordinary argv is not navigation. */
export function receiveDesktopUrl(spatial: SpatialLinkIngress, web: WebUrlIngress, url: string): void {
  if (/^amux:/iu.test(url)) spatial.receive(url)
  else web.receive(url)
}
export function receiveDesktopUrlArguments(spatial: SpatialLinkIngress, web: WebUrlIngress, argv: readonly string[]): void {
  for (const argument of argv) if (/^(amux|https?):/iu.test(argument)) receiveDesktopUrl(spatial, web, argument)
}
