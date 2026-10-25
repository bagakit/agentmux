import type { ConnectionDeliveryReceiptReason } from '@agentmux/core/connections'
import type { PreparedPublication } from './publication-wire.js'
import type { PublicationOperation, PublicationTarget, PublicationMapping } from './publication-store.js'

export type CardCreateReceipt = { state: 'confirmed'; id: string } | { state: 'unknown' | 'not-applied'; reason: ConnectionDeliveryReceiptReason }
export type PortraitReceipt = { state: 'confirmed' } | { state: 'unknown' | 'not-applied'; reason: ConnectionDeliveryReceiptReason }
/** Optional native effects stay inside their original publication operation. */
export type PublicationCardPreparation = {
  prepared: PreparedPublication
  receipt: { state: 'dispatching' } | CardCreateReceipt
  sequence: number
  useForMessage?: true
}
export type PublicationPortrait = { state: 'pending' | 'superseded' } | {
  state: 'dispatching' | 'unknown' | 'confirmed' | 'not-applied'
  prepared: PreparedPublication
  sequence: number
  receipt?: PortraitReceipt
}
/** Pure preparation followed by one exact native effect; no retry or history owner. */
export interface PublicationCardAdapter {
  prepareCreate(operation: Readonly<PublicationOperation>): PreparedPublication
  create(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal): Promise<CardCreateReceipt>
  preparePortrait(operation: Readonly<PublicationOperation>, sequence: number): PreparedPublication
  portrait(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping: Readonly<PublicationMapping>): Promise<PortraitReceipt>
  inspectPortrait(prepared: PreparedPublication, target: PublicationTarget, credential: string, signal: AbortSignal, mapping: Readonly<PublicationMapping>): Promise<PortraitReceipt | null>
}
