import { z } from 'zod'
import type { BrowserResultContext } from './browser-result-artifact.js'
import type { BrowserStructuredOutputRequest } from './browser-structured-output.js'

export const BROWSER_OUTCOME_LIMITS = { conditions: 8, requestBytes: 32 * 1024, documentBytes: 1024 * 1024 } as const
const text = z.string().min(1).max(128).refine(value => value.trim().length > 0)
const scalar = z.union([z.string().max(16 * 1024), z.number().finite(), z.boolean()])
const criterion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field-equals'), key: text, expected: scalar }).strict(),
  z.object({ kind: z.literal('download-readable'), path: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('human-checkpoint'), checkpointId: text }).strict()
])
const request = z.object({ criteria: z.array(criterion).min(1).max(BROWSER_OUTCOME_LIMITS.conditions) }).strict()

/** Finite Client conditions; this request never grants producer or approval authority. */
export type BrowserOutcomeCriterion = z.infer<typeof criterion>
export type BrowserOutcomeCriteriaRequest = z.infer<typeof request>
export function parseBrowserOutcomeCriteriaRequest(value: unknown): BrowserOutcomeCriteriaRequest {
  const parsed = request.parse(value)
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > BROWSER_OUTCOME_LIMITS.requestBytes) {
    throw new Error('Outcome conditions exceed their total byte budget.')
  }
  return parsed
}

export type BrowserOutcomeAssetRun = { runId: string; assetId: string; version: number }
export type BrowserOutcomeProducer = { operationId: string; navigationId: string }
export type BrowserRegisteredOutcomeCriterion =
  | { kind: 'field-equals'; key: string; expected: string | number | boolean;
      producer: BrowserOutcomeProducer & { sequence: number; request: BrowserStructuredOutputRequest } }
  | { kind: 'download-readable'; path: string; producer: BrowserOutcomeProducer }
  | { kind: 'human-checkpoint'; checkpointId: string }

/** Main binds these facts before the declared producer executes, in the existing journal/run. */
export type BrowserOutcomeRegistration = {
  context: BrowserResultContext
  assetRun?: BrowserOutcomeAssetRun
  criteria: BrowserRegisteredOutcomeCriterion[]
}
export type BrowserOutcomeStatus = 'passed' | 'not-met' | 'unavailable'
export type BrowserOutcomeConditionResult = { criterion: BrowserOutcomeCriterion; status: BrowserOutcomeStatus; reason: string }
/** No page values, previews, temporary parameters or raw errors are copied into this projection. */
export type BrowserOutcomeEvaluation = {
  context: BrowserResultContext
  assetRun?: BrowserOutcomeAssetRun
  status: BrowserOutcomeStatus
  conditions: BrowserOutcomeConditionResult[]
  warning?: string
}
export type BrowserOutcomeFieldRunInput = {
  request: BrowserStructuredOutputRequest
  criteria: BrowserOutcomeCriteriaRequest['criteria']
}

/** Event fact from the existing trusted Continue/control owner; waiting is not this fact. */
export type BrowserOutcomeHumanFact = BrowserOutcomeAssetRun & {
  browserId: string
  checkpointId: string
  origin: 'trusted-ui'
  controlBefore: 'human'
  confirmedAt: number
}
