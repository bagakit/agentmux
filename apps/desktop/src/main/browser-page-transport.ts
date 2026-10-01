import type { BrowserCdpSender } from './browser-page-snapshot.js'

/** Only the page-bound CDP facts consumed by the shared page dispatcher. */
export interface BrowserPageTransport {
  readonly sendCommand: BrowserCdpSender
  readonly frames: Map<string, BrowserCdpSender>
  readonly endedReason: string | null
  readonly frameDiscoveryFailure: string | null
  observe(listener: (method: string, params: unknown) => void): () => void
}
