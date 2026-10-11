import type { PublicationTarget, PublicationReceipt, PublicationMapping } from './publication-store.js'
import type { PublicationImage, ImageUploadReceipt } from './publication-image.js'
import type { PreparedPublication, PublicationPreparer } from './publication-wire.js'

/** Low-level adapter effects only. No history reader, Agent queue, retry loop or credentials in prepared data. */
export interface PublicationAdapter extends PublicationPreparer {
  readonly fragmentBytes: number
  /** A transport may reduce text capacity for this exact original target's encoded envelope. */
  fragmentBytesFor?(target: PublicationTarget): number
  /** This finite payload requires an explicit adapter implementation; speech support does not imply it. */
  readonly permissionActions?: true
  readonly images?: {
    readonly maxBytes: number
    accepts(image: PublicationImage): boolean
    upload(image: PublicationImage, target: PublicationTarget, credential: string, signal: AbortSignal): Promise<ImageUploadReceipt>
  }
  /** Retained mapping is the original durable platform identity, separate from request bytes. */
  dispatch(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt>
  /** Read the original platform effect. Absence alone cannot establish non-application. */
  inspect?(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null>
}
