import type { AgentSessionControl } from '../../../shared/contracts'
import type { BrowserInputScene } from '../../../shared/browser-input-context-capture'

export type BrowserOpinionSource = {
  control: AgentSessionControl
  name: string
  browserId: string
  operationId: string | undefined
  comment?: { operationId: string; sequence: number }
  scene?: BrowserInputScene
  sceneError?: string
}
/** A local draft, not Core intake or permission. Restoration never sends it. */
export type BrowserOpinionAttempt = { operationId: string; text: string; context: boolean; note?: string }
export type BrowserOpinionDraft = {
  original: BrowserOpinionSource | null
  text: string
  includeContext: boolean
  pending: BrowserOpinionAttempt | null
}
