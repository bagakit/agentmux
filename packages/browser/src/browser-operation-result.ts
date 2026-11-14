import type { BrowserResultReadInput, BrowserResultReadProjection } from '@agentmux/core/control'
import type { BrowserOperation } from './model/browser-operation.js'
import type { BrowserResultArtifactChunk, BrowserResultReadOptions } from './model/browser-result-artifact.js'

/** Read one already joined step. Observation failure cannot remove the original operation. */
export async function readBrowserOperationResult(operationId: string, input: BrowserResultReadInput, owner: {
  getOperation(id: string): Promise<BrowserOperation | null>
  readStepResult(id: string, sequence: number, options?: BrowserResultReadOptions): Promise<BrowserResultArtifactChunk>
}): Promise<{ runOperation: BrowserOperation | null; resultRead: BrowserResultReadProjection }> {
  const runOperation = await owner.getOperation(operationId)
  const step = runOperation?.steps.find(step => step.sequence === input.sequence)
  if (!step || step.method !== 'extractStructured') return { runOperation, resultRead: { sequence: input.sequence, status: 'not-recorded', warning: 'This original step has no retained structured result. No page was read.' } }
  try {
    const chunk = await owner.readStepResult(operationId, input.sequence, { ...(input.offset === undefined ? {} : { offset: input.offset }), ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }) })
    return { runOperation, resultRead: { sequence: input.sequence, status: 'available', chunk } }
  } catch {
    return { runOperation, resultRead: { sequence: input.sequence, status: 'unavailable', warning: 'The original structured result could not be read. Its operation and page remain; restore access and query this same operation. Extraction was not repeated.' } }
  }
}
