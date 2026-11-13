import type { BrowserCdpSender } from './browser-page-snapshot.js'

/** Only the page-bound CDP facts consumed by the shared page dispatcher. */
export interface BrowserPageTransport {
  readonly sendCommand: BrowserCdpSender
  readonly frames: Map<string, BrowserCdpSender>
  readonly endedReason: string | null
  readonly frameDiscoveryFailure: string | null
  /** `sessionId` names the child frame session an event came from; absent for the page's own session. */
  observe(listener: (method: string, params: unknown, sessionId?: string) => void): () => void
  /** Independent native session on this exact target. Ending it withdraws only its network rules. */
  openNetworkSession?(): Promise<BrowserNetworkSession>
}

export type BrowserNetworkSession = Pick<BrowserPageTransport, 'sendCommand' | 'observe' | 'endedReason'> & {
  /** Native session detach, never page close or another consumer's connection release. */
  close(): Promise<void>
}

/** Host receipt around one action's native input; it never implies ownership of another target. */
export type BrowserNativeInput = { input<T>(command: () => Promise<T>): Promise<T>; end(): void }
