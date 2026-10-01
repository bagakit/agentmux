import type { BrowserReplayStep } from './browser-operation.js'
import type { BrowserDemonstrationSuggestion } from './browser-demonstration-semantics.js'

/** Human demonstrations are reviewable drafts, never execution permission. */
export type BrowserDemonstrationStep = BrowserReplayStep & {
  id: string
  sequence: number
  recordedAt: number
  navigationId: string
  source: 'native-human' | 'navigation'
}
export type BrowserDemonstrationDraft = {
  id: string
  browserId: string
  navigationId: string
  url: string
  revision: number
  status: 'recording' | 'stopped' | 'interrupted'
  startedAt: number
  updatedAt: number
  steps: BrowserDemonstrationStep[]
  warning?: string
}
export type BrowserDemonstrationDocument = { version: 1; drafts: BrowserDemonstrationDraft[] }

/** The live Browser projection and read API share this single draft/warning contract. */
export type BrowserDemonstrationState = { draft: BrowserDemonstrationDraft | null; suggestions?: BrowserDemonstrationSuggestion[]; warning?: string }
