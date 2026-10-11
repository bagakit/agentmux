import type { SetupMessageReceptionPlan } from '../../connection-setup-adapter.js'
import { FEISHU_MESSAGE_EVENT } from './message.js'

const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const parse = (value: string) => { try { return record(JSON.parse(value)) } catch { return null } }
const supportedId = (v: unknown) => typeof v === 'string' && v.length > 0 || typeof v === 'number' && Number.isSafeInteger(v)
/** Only original grouped native rows participate, never UI aggregates or another identity bucket. */
function items(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null
  const result: Record<string, unknown>[] = []
  for (const group of value) {
    const rows = record(group)?.items
    if (!Array.isArray(rows)) return null
    for (const item of rows) {
      const row = record(item)
      if (!row || !supportedId(row.id)) return null
      result.push(row)
    }
  }
  return result
}
export const feishuMessageReceptionIntent = () => JSON.stringify({ eventId: FEISHU_MESSAGE_EVENT, eventMode: 4 })

export function reviewFeishuMessageReception(catalogState: string, settingsState: string): SetupMessageReceptionPlan {
  const catalog = items(parse(catalogState)?.events), settings = parse(settingsState), current = items(settings?.appEventDetails)
  const transport = settings?.eventMode === 4 ? 'persistent-connection' : settings?.eventMode === 1 ? 'webhook' : settings?.eventMode === 2 || settings?.eventMode === 3 ? 'function' : 'unknown'
  let reason: SetupMessageReceptionPlan['review']['reason'] = !catalog ? 'catalog-unconfirmed' : !current ? 'settings-unconfirmed' : undefined
  const matches = catalog?.filter(row => row.id === FEISHU_MESSAGE_EVENT) ?? []
  const candidates = matches.filter(row => Array.isArray(row.supportIdentityTypes) && row.supportIdentityTypes.includes(2))
  if (!reason && (matches.some(row => !Array.isArray(row.supportIdentityTypes)) || !candidates.length)) reason = 'event-unavailable'
  if (!reason && candidates.length !== 1) reason = 'event-ambiguous'
  const reception = reason ? 'unknown' : current!.some(row => row.id === candidates[0]!.id) ? 'subscribed' : 'missing'
  return { review: { reception, transport, ...(reason ? { reason } : {}) }, privateIntent: reception === 'missing' && transport === 'persistent-connection' ? feishuMessageReceptionIntent() : null }
}
