import type { PublicationTarget, PublicationReceipt } from './publication-store.js'
import type { PreparedPublication, PublicationPreparer } from './publication-wire.js'

/** Low-level adapter effects only. No history reader, Agent queue, retry loop or credentials in prepared data. */
export interface PublicationAdapter extends PublicationPreparer {
  readonly fragmentBytes: number
  dispatch(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal): Promise<PublicationReceipt>
  /** Read the original platform effect. Absence alone cannot establish non-application. */
  inspect?(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal): Promise<PublicationReceipt | null>
}
