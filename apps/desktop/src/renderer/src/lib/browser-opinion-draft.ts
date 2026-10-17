import type { AgentSessionControl } from '../../../shared/contracts'
import { parseBrowserInputContext } from '@agentmux/core/browser-input-context'
import type { BrowserInputScene, BrowserInputSceneReference, BrowserInputSelectionReceipt } from '../../../shared/browser-input-context-capture'

export type BrowserOpinionSource = {
  control: AgentSessionControl
  name: string
  browserId: string
  operationId: string | undefined
  comment?: { operationId: string; sequence: number }
  scene?: BrowserInputScene
  sceneError?: string
  /** The text observation remains unchanged when an optional processed image is removed. */
  selection?: BrowserInputSelectionReceipt
  selectionPreparation?: { operationId: string; frame: BrowserInputSceneReference }
}
/** A local draft, not Core intake or permission. Restoration never sends it. */
export type BrowserOpinionAttempt = { operationId: string; text: string; context: boolean; note?: string }
export type BrowserOpinionDraft = {
  original: BrowserOpinionSource | null
  text: string
  includeContext: boolean
  pending: BrowserOpinionAttempt | null
}

/** Restored display data cannot silently remove an image or borrow another text observation. */
export function browserOpinionSelection(source: BrowserOpinionSource): BrowserInputSelectionReceipt | undefined {
  if (source.selection === undefined) return undefined
  const invalid = () => new Error('Saved image details cannot be confirmed. Remove the image or choose text-only; your draft is kept.')
  try {
    const receipt = source.selection
    const base = parseBrowserInputContext(source.scene?.inputContext)
    const context = parseBrowserInputContext(receipt.scene.inputContext)
    const { selection, ...textContext } = context
    const image = selection?.attachment, artifact = receipt.artifact, reference = receipt.scene.reference
    if (base.selection !== undefined || JSON.stringify(base) !== JSON.stringify(textContext) || !selection || !image ||
        source.scene?.reference.hostId !== source.control.hostId || base.browser.hostId !== source.control.hostId || base.browser.browserId !== source.browserId ||
        reference.hostId !== source.control.hostId || typeof reference.captureId !== 'string' || !reference.captureId.trim() ||
        !['confirmed', 'unconfirmed'].includes(receipt.scene.diskDurability) ||
        typeof receipt.operationId !== 'string' || !receipt.operationId.trim() ||
        selection.source.hostId !== source.control.hostId || selection.source.browserId !== source.browserId || image.hostId !== source.control.hostId ||
        artifact.diskDurability !== 'confirmed' || artifact.path !== image.path || artifact.width !== image.width || artifact.height !== image.height ||
        artifact.sha256 !== image.sha256 || !/^[a-f0-9]{64}$/u.test(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 ||
        source.selectionPreparation && (source.selectionPreparation.operationId !== receipt.operationId ||
          source.selectionPreparation.frame.hostId !== selection.source.hostId || source.selectionPreparation.frame.captureId !== selection.frameId)) throw invalid()
    return receipt
  } catch { throw invalid() }
}
