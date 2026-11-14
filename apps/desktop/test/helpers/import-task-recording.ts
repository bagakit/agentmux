import type { BrowserTaskAssets } from '../../src/main/browser-task-assets.js'
import type { BrowserDemonstrationDraft } from '../../src/shared/browser-demonstration.js'
import { browserTaskCreateInput } from '@agentmux/core/control'

/** Each fixture call represents a deliberately new import, with its own stable client proposal. */
export function importTaskRecording(owner: BrowserTaskAssets, recording: BrowserDemonstrationDraft, name?: string) {
  return owner.importRecording(browserTaskCreateInput(recording, name), async () => recording)
}
