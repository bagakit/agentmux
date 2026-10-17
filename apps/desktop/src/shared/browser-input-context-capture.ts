import type { BrowserInputContext, BrowserInputSelection } from '@agentmux/core/browser-input-context'
import type { AgentInputContextCaptureRead } from '@agentmux/core/agent-input-context-capture'
import type { AgentSessionControl, BrowserPng, BrowserScreenshotCapture } from './contracts'

/** A frozen Main observation. This is neither a live DOM handle nor an input grant. */
export type BrowserInputSceneReference = { hostId: string; captureId: string }
export type BrowserInputScene = {
  reference: BrowserInputSceneReference
  inputContext: BrowserInputContext
  diskDurability: 'confirmed' | 'unconfirmed'
  /** Original pixels stay in the editor; the journal retains only this observation. */
  frame?: BrowserInputFrame
}
export type BrowserInputFrame = Pick<BrowserInputSelection, 'capturedAt' | 'source' | 'observationEnd' | 'viewport'> & {
  width: number; height: number; sha256: string
}
export type BrowserInputFrameCapture = {
  capture: BrowserScreenshotCapture
  before: BrowserInputContext
  after: BrowserInputContext
}
export type BrowserInputFrameResult = { scene: BrowserInputScene; capture: BrowserScreenshotCapture }
export type BrowserInputSelectionPrepare = {
  /** The text comment and image may refer to different historical observations. */
  scene: BrowserInputSceneReference
  frame: BrowserInputSceneReference
  operationId: string
  region: NonNullable<BrowserInputSelection['region']>
  crop?: BrowserInputSelection['crop']
  png: BrowserPng
}
export type BrowserInputSelectionArtifact = {
  path: string; sha256: string; byteLength: number; diskDurability: 'confirmed'; width: number; height: number
}
export type BrowserInputSelectionReceipt = { operationId: string; scene: BrowserInputScene; artifact: BrowserInputSelectionArtifact }
export type BrowserInputSelectionRead = { operationId: string; state: 'absent' | 'unconfirmed' | 'prepared'; receipt?: BrowserInputSelectionReceipt }
export type BrowserInputContextFreeze = {
  scene: BrowserInputSceneReference
  control: AgentSessionControl
  operationId: string
  prompt: string
  agentMuxNote?: string
}
export type BrowserInputContextFreezeReceipt = AgentInputContextCaptureRead & { record: NonNullable<AgentInputContextCaptureRead['record']> }
