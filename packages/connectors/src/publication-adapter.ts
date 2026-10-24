import type { PublicationTarget, PublicationReceipt, PublicationMapping, PublicationPayload, PublicationTextFragment, PublicationOperation } from './publication-store.js'
import type { PublicationImage, ImageUploadReceipt, PublicationFile, FileUploadReceipt } from './publication-resource.js'
import type { PreparedPublication, PublicationPreparer, PublicationEffectContext } from './publication-wire.js'
import type { PublicationSpeaker } from './publication-speaker.js'

/** Low-level adapter effects only. No history reader, Agent queue, retry loop or credentials in prepared data. */
export interface PublicationAdapter extends PublicationPreparer {
  readonly fragmentBytes: number
  /** A transport may reduce text capacity for this exact original target's encoded envelope. */
  fragmentBytesFor?(target: PublicationTarget): number
  /** Native text structure and encoded request budgets belong to the adapter.
   * Undefined delegates this payload to the ordinary UTF-8 budget. */
  fragmentText?(payload: Extract<PublicationPayload, { kind: 'speech' }>, target: PublicationTarget, speaker?: PublicationSpeaker, originalMessage?: PublicationOperation['originalMessage']): readonly PublicationTextFragment[] | undefined
  /** This finite payload requires an explicit adapter implementation; speech support does not imply it. */
  readonly permissionActions?: true
  readonly questionActions?: true
  readonly queryFeedback?: true
  readonly images?: {
    readonly maxBytes: number
    accepts(image: PublicationImage): boolean
    upload?(image: PublicationImage, target: PublicationTarget, credential: string, signal: AbortSignal): Promise<ImageUploadReceipt>
  }
  readonly files?: {
    readonly maxBytes: number
    accepts(file: PublicationFile): boolean
    upload?(file: PublicationFile, target: PublicationTarget, credential: string, signal: AbortSignal): Promise<FileUploadReceipt>
  }
  /** Retained mapping is the original durable platform identity, separate from request bytes. */
  dispatch(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>, context?: PublicationEffectContext): Promise<PublicationReceipt>
  /** Read the original platform effect. Absence alone cannot establish non-application. */
  inspect?(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping?: Readonly<PublicationMapping>): Promise<PublicationReceipt | null>
}
