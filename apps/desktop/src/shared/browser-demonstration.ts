import type { BrowserReplayStep } from './browser-operation.js'

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
