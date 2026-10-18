import type { APIInteraction, APIUser } from 'discord-api-types/v10'
import type { REST } from '@discordjs/rest'
import type { ConnectionConfig } from '@agentmux/core/connections'
import type { ConnectionQuestionForm, ConnectionQuestionFormInput, VerifiedIngressAction } from '../../durable-ingress.js'
import type { AgentSessionHistoryQuestion } from '@agentmux/core'
import { discordId, discordFailure } from './protocol.js'

export function discordQuestionComponents(questions: readonly AgentSessionHistoryQuestion[]): unknown[] | null {
  const fields: unknown[] = []
  for (const [index, question] of questions.entries()) {
    if (question.options.length > 25 || !question.acceptsText && !question.options.length) return null
    if (question.options.length) fields.push({ type: 18, label: `Question ${index + 1} · options`, component: { type: 3, custom_id: 'o' + index,
      required: !question.acceptsText, min_values: question.acceptsText ? 0 : 1, max_values: 1,
      options: question.options.map((option, ordinal) => ({ label: option.label.length <= 100 ? option.label : `Option ${ordinal + 1} (see original question)`, value: String(ordinal) })) } })
    if (question.acceptsText) fields.push({ type: 18, label: `Question ${index + 1} · text`, component: { type: 4, custom_id: 't' + index, style: 2, required: !question.options.length, max_length: 4000 } })
  }
  return fields.length > 0 && fields.length <= 5 ? fields : null
}
const ref = (value: string): string => /^[a-zA-Z0-9_-]+$/u.test(value) && value.length <= 77 ? value : discordFailure('DISCORD_ACTION_INVALID')
function answers(questions: readonly AgentSessionHistoryQuestion[], components: unknown): NonNullable<VerifiedIngressAction['answers']> {
  if (!Array.isArray(components)) return discordFailure('DISCORD_ANSWERS_INVALID')
  const fields = new Map<string, Record<string, unknown>>()
  for (const row of components) {
    const component = row?.component ?? (Array.isArray(row?.components) && row.components.length === 1 ? row.components[0] : undefined)
    if (!component || typeof component.custom_id !== 'string' || fields.has(component.custom_id)) return discordFailure('DISCORD_ANSWERS_INVALID')
    fields.set(component.custom_id, component)
  }
  const result = questions.map((question, index) => {
    const selected = fields.get('o' + index), typed = fields.get('t' + index)
    fields.delete('o' + index); fields.delete('t' + index)
    const text = typed?.value
    const values = selected?.values
    if (typed && (!question.acceptsText || typed.type !== 4 || typeof text !== 'string') || selected && (selected.type !== 3 || !Array.isArray(values))) return discordFailure('DISCORD_ANSWERS_INVALID')
    const optionIds = Array.isArray(values) ? values.map(value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/u.test(value) ? question.options[Number(value)]?.id : undefined) : []
    if (optionIds.length > 1 || optionIds.some(value => !value) || typeof text === 'string' && text.trim() && optionIds.length) return discordFailure('DISCORD_ANSWERS_INVALID')
    if (typeof text === 'string' && text.trim()) return { questionId: question.id, text }
    if (!optionIds.length) return discordFailure('DISCORD_ANSWERS_INVALID')
    return { questionId: question.id, optionIds: optionIds as string[] }
  })
  if (fields.size) return discordFailure('DISCORD_ANSWERS_INVALID')
  return result
}
/** Native callback presentation only. Original ingress and Core still authorize and execute the answer. */
export async function handleDiscordInteraction(input: {
  config: ConnectionConfig; interaction: APIInteraction; botId: string; rest: REST; signal: AbortSignal
  callbackObservation?(confirmed: boolean): void
  questionForm?(input: ConnectionQuestionFormInput): ConnectionQuestionForm | null
  receive(event: VerifiedIngressAction, acknowledge: () => Promise<void>): Promise<unknown>
}): Promise<void> {
  const interaction = input.interaction
  if (interaction.application_id !== input.config.application.appId || !interaction.channel_id || !('data' in interaction) || !interaction.data || !('custom_id' in interaction.data)) return
  const user = interaction.member?.user ?? interaction.user
  if (!user || user.bot) return
  const actor = { application: input.config.application, idType: 'snowflake', userId: discordId(user.id) }
  const customId = interaction.data.custom_id
  const callback = async (body: unknown) => {
    try { await input.rest.post(`/interactions/${discordId(interaction.id)}/${interaction.token}/callback`, { body, signal: input.signal, auth: false }); input.callbackObservation?.(true) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 40060) input.callbackObservation?.(true)
      else input.callbackObservation?.(false)
    }
  }
  const rejected = () => callback({ type: 4, data: { flags: 64, content: 'This original action is unavailable. Review it in AgentMux.' } })
  if (interaction.type === 3 && customId.startsWith('q:')) {
    if (interaction.message.author.id !== input.botId) return
    const actionRef = ref(customId.slice(2)), sourceMessageId = discordId(interaction.message.id)
    const form = input.questionForm?.({ connectionId: input.config.connectionId, application: input.config.application, actor, externalConversationId: interaction.channel_id, sourceMessageId, actionRef })
    const components = form && discordQuestionComponents(form.questions)
    if (!components) return await rejected()
    await callback({ type: 9, data: { custom_id: 'a:' + actionRef + ':' + sourceMessageId, title: 'Answer original questions', components } })
    return
  }
  let event: VerifiedIngressAction
  if (interaction.type === 3 && customId.startsWith('p:')) {
    if (interaction.message.author.id !== input.botId) return
    event = { kind: 'action', eventId: 'interaction:' + discordId(interaction.id), actor, externalConversationId: interaction.channel_id,
      sourceMessageId: discordId(interaction.message.id), actionRef: ref(customId.slice(2)) }
  } else if (interaction.type === 5 && customId.startsWith('a:')) {
    const parts = customId.split(':'), actionRef = ref(parts[1] ?? ''), sourceMessageId = discordId(parts[2])
    if (parts.length !== 3) return await rejected()
    const form = input.questionForm?.({ connectionId: input.config.connectionId, application: input.config.application, actor, externalConversationId: interaction.channel_id, sourceMessageId, actionRef })
    if (!form) return await rejected()
    let submitted: NonNullable<VerifiedIngressAction['answers']>
    try { submitted = answers(form.questions, interaction.data.components) } catch { return await rejected() }
    event = { kind: 'action', eventId: 'interaction:' + discordId(interaction.id), actor, externalConversationId: interaction.channel_id, sourceMessageId, actionRef, answers: submitted }
  } else return
  await input.receive(event, () => callback({ type: 5, data: { flags: 64 } }))
}
