import type { ConnectionApplication } from '@agentmux/core/connections'
import type { VerifiedIngressAction } from '../../durable-ingress.js'
import { feishuFailure, feishuIdentity } from './message.js'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
function identity(value: unknown): string | undefined {
  try { return feishuIdentity(value) } catch { return undefined }
}
/** Qualifies feedback only; the authenticated receiver and durable ingress still own acceptance. */
export function isFeishuQuestionSubmit(raw: string): boolean {
  const action = object(object(object(JSON.parse(raw))?.event)?.action)
  return action?.tag === 'button' && action.name === 'submit_original_answer'
}
/** Authentication belongs to the private SDK witness. Unsupported fields remain complete in raw. */
export function readFeishuAction(raw: string, application: ConnectionApplication): VerifiedIngressAction | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return feishuFailure('FEISHU_EVENT_INVALID') }
  const payload = object(parsed), header = object(payload?.header)
  if (header?.event_type !== 'card.action.trigger') return null
  if (payload?.schema !== '2.0' || header.app_id !== application.appId) feishuFailure('FEISHU_EVENT_IDENTITY_MISMATCH')
  const event = object(payload.event), operator = object(event?.operator), context = object(event?.context)
  const userId = identity(operator?.open_id), externalConversationId = identity(context?.open_chat_id), sourceMessageId = identity(context?.open_message_id)
  const actionRef = identity(object(object(event?.action)?.value)?.actionRef)
  const action = object(event?.action), value = object(action?.value), fields = value?.questionFields, form = object(action?.form_value)
  const answers = Array.isArray(fields) && form ? fields.map(value => {
    const field = object(value), questionId = identity(field?.questionId)
    if (!questionId) return null
    const entered = typeof field?.textField === 'string' ? form[field.textField] : undefined
    if (typeof entered === 'string' && entered.trim()) return { questionId, text: entered }
    const selected = typeof field?.optionField === 'string' ? form[field.optionField] : undefined
    // This form uses the native single-select control; an array is not its submitted value.
    const selections = typeof selected === 'string' ? [selected] : []
    const options = Array.isArray(field?.optionIds) ? field.optionIds : []
    const optionIds = selections.map(index => typeof index === 'string' && /^(0|[1-9][0-9]*)$/u.test(index) ? identity(options[Number(index)]) : undefined)
    return optionIds.length && optionIds.every((id): id is string => !!id) ? { questionId, optionIds } : null
  }) : undefined
  return { kind: 'action', eventId: feishuIdentity(header.event_id),
    ...(userId === undefined ? {} : { actor: { application: { ...application }, idType: 'open_id', userId } }),
    ...(externalConversationId === undefined ? {} : { externalConversationId }),
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }), ...(actionRef === undefined ? {} : { actionRef }),
    ...(answers?.length && answers.every((answer): answer is NonNullable<typeof answer> => !!answer) ? { answers } : {}) }
}
