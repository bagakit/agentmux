import type { PublicationTarget, PublicationReceipt, PublicationMapping } from './publication-store.js'
import type { PreparedPublication, PublicationPreparer } from './publication-wire.js'

/** Low-level adapter effects only. No history reader, Agent queue, retry loop or credentials in prepared data. */
export interface PublicationAdapter extends PublicationPreparer {
  readonly fragmentBytes: number
  /** Retained mapping is the original durable platform identity, separate from request bytes. */
  dispatch(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt>
  /** Read the original platform effect. Absence alone cannot establish non-application. */
  inspect?(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null>
}
