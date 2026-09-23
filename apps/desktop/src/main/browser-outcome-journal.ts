import { z } from 'zod'
import { BROWSER_OUTCOME_LIMITS, parseBrowserOutcomeCriteriaRequest,
  type BrowserOutcomeEvaluation, type BrowserOutcomeRegistration, type BrowserRegisteredOutcomeCriterion } from '../shared/browser-outcome-criteria.js'
import { parseBrowserStructuredOutputRequest } from './browser-structured-output.js'

const identity = z.string().min(1).max(512)
const context = z.object({ workspaceId: identity.nullable(), browserId: identity,
  operationId: identity, navigationId: identity }).strict()
const assetRun = z.object({ runId: identity, assetId: identity, version: z.number().int().positive() }).strict()
const producer = z.object({ operationId: identity, navigationId: identity }).strict()
const criterion = z.unknown().transform((value, ctx) => {
  try { return parseBrowserOutcomeCriteriaRequest({ criteria: [value] }).criteria[0]! }
  catch { ctx.addIssue({ code: 'custom', message: 'Unsupported completion condition' }); return z.NEVER }
})
const registration = z.object({ context, assetRun: assetRun.optional(), criteria: z.array(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field-equals'), key: identity, expected: z.union([z.string(), z.number().finite(), z.boolean()]),
    producer: producer.extend({ sequence: z.number().int().positive(), request: z.unknown().transform((value, ctx) => {
      try { return parseBrowserStructuredOutputRequest(value) }
      catch { ctx.addIssue({ code: 'custom', message: 'Invalid registered extraction' }); return z.NEVER }
    }) }).strict() }).strict(),
  z.object({ kind: z.literal('download-readable'), path: identity, producer }).strict(),
  z.object({ kind: z.literal('human-checkpoint'), checkpointId: identity }).strict()
])).min(1).max(BROWSER_OUTCOME_LIMITS.conditions) }).strict()
const status = z.enum(['passed', 'not-met', 'unavailable'])
const evaluation = z.object({ context, assetRun: assetRun.optional(), status,
  conditions: z.array(z.object({ criterion, status, reason: z.string().min(1).max(1024) }).strict())
    .max(BROWSER_OUTCOME_LIMITS.conditions), warning: z.string().max(1024).optional() }).strict()

function conditionValue(c: BrowserRegisteredOutcomeCriterion) {
  return c.kind === 'field-equals' ? { kind: c.kind, key: c.key, expected: c.expected }
    : c.kind === 'download-readable' ? { kind: c.kind, path: c.path }
      : { kind: c.kind, checkpointId: c.checkpointId }
}

export type BrowserOutcomeJournalState = { registration: BrowserOutcomeRegistration; evaluation?: BrowserOutcomeEvaluation }

/** The existing operation journal is the only durable owner; reject damaged or unjoined projections. */
export function normalizeBrowserOutcomeJournal(value: unknown, operationId: string, browserId: string): BrowserOutcomeJournalState | undefined {
  try {
    const raw = z.object({ registration, evaluation: evaluation.optional() }).strict().parse(value)
    const r = raw.registration
    if (r.context.operationId !== operationId || r.context.browserId !== browserId ||
        Buffer.byteLength(JSON.stringify(r)) > BROWSER_OUTCOME_LIMITS.requestBytes) return undefined
    const declared = parseBrowserOutcomeCriteriaRequest({ criteria: r.criteria.map(conditionValue) }).criteria
    if (raw.evaluation) {
      const e = raw.evaluation
      if (JSON.stringify(e.context) !== JSON.stringify(r.context) ||
          JSON.stringify(e.assetRun) !== JSON.stringify(r.assetRun) ||
          (e.conditions.length === 0 ? e.status !== 'unavailable' :
            e.conditions.length !== declared.length || e.conditions.some((c, i) =>
              JSON.stringify(c.criterion) !== JSON.stringify(declared[i])))) return undefined
      const aggregate = e.conditions.length === 0 || e.conditions.some(c => c.status === 'unavailable') ? 'unavailable'
        : e.conditions.every(c => c.status === 'passed') ? 'passed' : 'not-met'
      if (e.status !== aggregate) return undefined
    }
    return { registration: { context: r.context, criteria: r.criteria, ...(r.assetRun ? { assetRun: r.assetRun } : {}) },
      ...(raw.evaluation ? { evaluation: { context: raw.evaluation.context, status: raw.evaluation.status,
        conditions: raw.evaluation.conditions, ...(raw.evaluation.assetRun ? { assetRun: raw.evaluation.assetRun } : {}),
        ...(raw.evaluation.warning ? { warning: raw.evaluation.warning } : {}) } } : {}) }
  } catch { return undefined }
}
