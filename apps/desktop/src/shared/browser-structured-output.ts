import type { BrowserResultArtifactReference, BrowserResultContext } from './browser-result-artifact.js'

export const BROWSER_STRUCTURED_LIMITS = {
  fields: 32, selectorCharacters: 512, elements: 4096, textNodes: 8192,
  fieldBytes: 16 * 1024, totalBytes: 256 * 1024, previewBytes: 256
} as const

export type BrowserStructuredType = 'string' | 'number' | 'boolean'
export type BrowserStructuredValue = string | number | boolean
export type BrowserStructuredFieldRequest = {
  key: string
  type: BrowserStructuredType
  source: { selector: string; read: 'text' | 'value' | 'checked' | 'attribute'; attribute?: string }
}
export type BrowserStructuredOutputRequest = {
  within?: string
  withinRef?: string
  fields: BrowserStructuredFieldRequest[]
}
/** The current Main owner and resolved T002 document, never supplied by the script. */
export type BrowserStructuredSource = BrowserResultContext & {
  url: string
  document: string
  /** URL of the actual rooted document; it can differ from the Browser URL in a frame. */
  documentUrl: string | null
  scope: { kind: 'page' | 'subtree'; within?: string; withinRef?: string }
}
export type BrowserStructuredWork = {
  visitedElements: number
  elementWalkSteps: number
  selectorChecks: number
  textNodes: number
  textWalkSteps: number
  reads: number
  /** UTF8 bytes actually collected from string reads; checked property reads count in reads. */
  readBytes: number
}
type FieldIdentity = BrowserStructuredFieldRequest
export type BrowserStructuredField = FieldIdentity & (
  | { status: 'observed'; value: BrowserStructuredValue }
  | { status: 'type-error'; actual: string | boolean; detail: string }
  | { status: 'truncated'; detail: string; preview?: string }
  | { status: 'missing' | 'ambiguous' | 'unavailable' | 'page-changed'; detail: string }
)
/** Full values, requested schema and actual source remain in one T003 artifact. */
export type BrowserStructuredDocument = {
  schema: 'browser-structured-output.v1'
  request: BrowserStructuredOutputRequest
  source: BrowserStructuredSource
  fields: BrowserStructuredField[]
  work: BrowserStructuredWork
}
/** A preview is never a complete value and must not be used to evaluate a condition. */
export type BrowserStructuredFieldSummary = FieldIdentity & {
  status: BrowserStructuredField['status']
  detail?: string
  inline: boolean
  value?: BrowserStructuredValue
  actual?: string | boolean
  preview?: string
  valueBytes?: number
}
export type BrowserStructuredOutputReceipt = {
  kind: 'browser-structured-output'
  status: 'complete' | 'partial' | 'page-changed' | 'unavailable'
  source: BrowserStructuredSource
  fields: BrowserStructuredFieldSummary[]
  /** null means the failed CDP read did not expose its actual work. */
  work: BrowserStructuredWork | null
  artifactStatus: 'available' | 'unavailable' | 'not-recorded'
  artifact?: BrowserResultArtifactReference
  warning?: string
}
