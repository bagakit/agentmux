import type { BrowserPng } from './contracts'
import type { BrowserStructuredOutputReceipt } from './browser-structured-output'

export type BrowserEvidenceIdentity = {
  operationId: string
  sequence: number
  browserId: string
  navigationId: string
}

/** Only this small reference travels in activity events and Control receipts. */
export type BrowserStepEvidenceReference = BrowserEvidenceIdentity & {
  id: string
  kind: BrowserStepEvidenceContent['kind']
  capturedAt: number
  byteLength: number
  truncated?: boolean
}

export type BrowserStepEvidenceContent =
  | { kind: 'page'; text: string; truncated: boolean }
  | { kind: 'screenshot'; image: BrowserPng }
  | { kind: 'structured-output'; receipt: BrowserStructuredOutputReceipt }
  | { kind: 'diagnostic'; code: 'page-call-failed'; message: string; nextAction: string }

export type BrowserStepEvidenceItem = {
  reference: BrowserStepEvidenceReference
  content: BrowserStepEvidenceContent
}

export type BrowserStepEvidenceRead = {
  operationId: string
  sequence: number
  items: BrowserStepEvidenceItem[]
  status: 'available' | 'not-recorded' | 'unavailable'
  /** A retained step remains visible even when one of its payloads is unavailable. */
  warning?: string
}
