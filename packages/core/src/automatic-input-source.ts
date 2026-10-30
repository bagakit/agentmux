import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
/** An opaque, original configuration owner and its exact binding generation. */
export type AutomaticInputSource = { sourceId: string; revision: string }
export type AgentStandingIntentReference = AutomaticInputSource & { intentId: string; operationId: string }
export function parseAutomaticInputSource(value: unknown): AutomaticInputSource {
  const p = rpcRecord(value, ['sourceId','revision'])
  for (const key of ['sourceId','revision']) if (typeof p[key] !== 'string' || !p[key] || p[key].length > 16384 || /[\0\r\n]/u.test(p[key] as string)) throw new AgentMuxError('Automatic input requires its original configuration source and binding generation.', 'INVALID_CONTROL_REQUEST')
  return { sourceId: p.sourceId as string, revision: p.revision as string }
}
export function sameAutomaticInputSource(a: AutomaticInputSource | undefined, b: AutomaticInputSource | undefined): boolean {
  return a?.sourceId === b?.sourceId && a?.revision === b?.revision
}
export function parseStandingIntentReference(value: unknown): AgentStandingIntentReference {
  const p = rpcRecord(value, ['sourceId','revision','intentId','operationId'])
  const source = parseAutomaticInputSource({ sourceId: p.sourceId, revision: p.revision })
  for (const key of ['intentId','operationId']) if (typeof p[key] !== 'string' || !p[key] || p[key].length > 512 || /[\0\r\n]/u.test(p[key] as string)) throw new AgentMuxError('Standing recovery requires its exact original intent and operation.', 'INVALID_CONTROL_REQUEST')
  return { ...source, intentId: p.intentId as string, operationId: p.operationId as string }
}
