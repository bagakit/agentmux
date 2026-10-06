import { isObjectId } from './object-id.js'

/** Original diagnostic ID format; validity grants no lookup or input authority. */
export function isDeliveryLogId(value: unknown): value is string {
  return isObjectId(value) || typeof value === 'string' && /^delivery-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}
