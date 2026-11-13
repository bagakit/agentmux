import type { BrowserTaskAsset } from '../../../shared/browser-task-assets'
import { parseBrowserTaskCreateInput, type BrowserTaskCreateInput, type BrowserTaskCreateStatus } from '../../../shared/browser-task-creation'

export type BrowserTaskCreationPorts = {
  keep(input: BrowserTaskCreateInput | null, expectedOperationId?: string): Promise<boolean>
  create(input: BrowserTaskCreateInput): Promise<BrowserTaskAsset>
  inspect(input: BrowserTaskCreateInput): Promise<BrowserTaskCreateStatus>
  isCurrent(input: BrowserTaskCreateInput): boolean
  select(assetId: string): void
}
async function selectOriginal(ports: BrowserTaskCreationPorts, input: BrowserTaskCreateInput, assetId: string): Promise<void> {
  if (!ports.isCurrent(input)) return
  if (assetId !== input.assetId) throw new Error('The task creation receipt belongs to another asset. The original input is kept.')
  const cleared = await ports.keep(null, input.createOperationId)
  if (cleared && ports.isCurrent(input)) ports.select(assetId)
}
/** GUI owns pending input; the original Main owner alone decides whether an asset exists. */
export async function submitBrowserTaskCreation(ports: BrowserTaskCreationPorts, input: BrowserTaskCreateInput): Promise<void> {
  if (!await ports.keep(input) || !ports.isCurrent(input)) return
  const asset = await ports.create(input)
  if (asset.browserId !== input.browserId || !asset.creation || JSON.stringify(parseBrowserTaskCreateInput(asset.creation)) !== JSON.stringify(parseBrowserTaskCreateInput(input))) throw new Error('The task creation receipt belongs to another intent. The original input is kept.')
  await selectOriginal(ports, input, asset.id)
}
export async function inspectBrowserTaskCreation(ports: BrowserTaskCreationPorts, input: BrowserTaskCreateInput): Promise<void> {
  const result = await ports.inspect(input)
  if (result.createOperationId !== input.createOperationId || result.assetId !== input.assetId || result.browserId !== input.browserId) throw new Error('The original task creation receipt is unconfirmed. Its input is kept.')
  if (result.status !== 'created') throw new Error(result.warning ?? 'No saved receipt exists for this original import. Continue this same request; its asset identity will be retained.')
  await selectOriginal(ports, input, result.assetId)
}
