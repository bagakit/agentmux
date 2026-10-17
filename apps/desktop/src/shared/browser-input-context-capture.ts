import type { BrowserInputContext } from '@agentmux/core/browser-input-context'
import type { AgentInputContextCaptureRead } from '@agentmux/core/agent-input-context-capture'
import type { AgentSessionControl } from './contracts'

/** A frozen Main observation. This is neither a live DOM handle nor an input grant. */
export type BrowserInputSceneReference = { hostId: string; captureId: string }
export type BrowserInputScene = {
  reference: BrowserInputSceneReference
  inputContext: BrowserInputContext
  diskDurability: 'confirmed' | 'unconfirmed'
}
export type BrowserInputContextFreeze = {
  scene: BrowserInputSceneReference
  control: AgentSessionControl
  operationId: string
  prompt: string
  agentMuxNote?: string
}
export type BrowserInputContextFreezeReceipt = AgentInputContextCaptureRead & { record: NonNullable<AgentInputContextCaptureRead['record']> }
