import type { QuestionPublicationPayload } from '../../publication-store.js'
import { feishuSpeakerIdentity, type FeishuRoleSpeaker } from './role-card.js'

/** Native form field names and callback layout belong only to this channel. */
export function feishuQuestionCard(payload: QuestionPublicationPayload, agentSessionId: string, speaker: Readonly<FeishuRoleSpeaker>): Record<string, unknown> {
  const text = (content: string) => ({ tag: 'plain_text', content })
  const status = { pending: 'Choose one option or write an answer. Written text is used when provided.',
    'response-sent': 'Answer submitted to the original Agent. Native completion remains separate.',
    unconfirmed: 'Answer delivery is unconfirmed. It will not be sent again.',
    unavailable: 'Answer here is unavailable. Open the original conversation to continue.' }[payload.status]
  const elements: Record<string, unknown>[] = [feishuSpeakerIdentity(speaker, 'Question')]
  if (payload.status !== 'pending') elements.push({ tag: 'div', text_size: 'normal', text: text(payload.text) })
  // Layout deduplication only: the typed original questions remain readable in every status.
  if (payload.status !== 'pending') for (const question of payload.questions) {
    if (!payload.text.includes(question.prompt) || question.options.some(option => !payload.text.includes(option.label)))
      elements.push({ tag: 'div', text_size: 'normal', text: text([question.prompt, ...question.options.map(option => `- ${option.label}`)].join('\n')) })
  }
  const statusElement = { tag: 'div', text_size: 'notation', text: { ...text(payload.status === 'unavailable' ? payload.unavailableReason ?? status : status), text_size: 'notation', text_color: 'grey' } }
  if (payload.status !== 'pending' || !payload.actionRef) elements.push(statusElement)
  if (payload.status !== 'pending') for (const answer of payload.answers ?? []) {
    const index = payload.questions.findIndex(question => question.id === answer.questionId)
    if (index !== -1) elements.push({ tag: 'div', text_size: 'normal', text: text(`Answer ${index + 1}: ${answer.answer}`) })
  }
  const actions: Record<string, unknown>[] = []
  if (payload.status === 'pending' && payload.actionRef) {
    const fields = payload.questions.map((question, index) => ({ questionId: question.id,
      ...(question.options.length ? { optionField: `question_${index}_option`, optionIds: question.options.map(option => option.id) } : {}),
      ...(question.acceptsText ? { textField: `question_${index}_text` } : {}) }))
    elements.push(...payload.questions.flatMap((question, index) => [
      { tag: 'div', text_size: 'normal', text: text(question.prompt) },
      ...(index === 0 ? [statusElement] : []),
      ...(question.options.length ? [{ tag: 'select_static', name: fields[index]!.optionField, behaviors: [], placeholder: text('Choose an option'), width: 'fill',
        options: question.options.map((option, optionIndex) => ({ text: text(option.label), value: String(optionIndex) })) }] : []),
      ...(question.acceptsText ? [{ tag: 'input', name: fields[index]!.textField, input_type: 'multiline_text', placeholder: text('Your answer'),
        label: text(question.options.length ? 'Or write your answer' : 'Your answer'), label_position: 'top', rows: 2, max_rows: 4, show_icon: false, width: 'fill' }] : [])
    ]))
    actions.push({ tag: 'button', name: 'submit_original_answer', text: text('Submit answers'), type: 'primary', size: 'small', width: 'fill',
      icon: { tag: 'standard_icon', token: 'send_outlined' }, action_type: 'form_submit', form_name: 'original_question', form_action_type: 'submit',
      value: { actionRef: payload.actionRef, questionFields: fields } })
  }
  actions.push({ tag: 'button', text: text('Open in amux'), type: 'default', size: 'small', width: 'fill',
    icon: { tag: 'standard_icon', token: 'chat_outlined' },
    behaviors: [{ type: 'open_url', default_url: `amux://agent/${encodeURIComponent(agentSessionId)}` }] })
  elements.push({ tag: 'column_set', flex_mode: 'none', horizontal_spacing: '8px', margin: '0px',
    columns: actions.map(action => ({ tag: 'column', width: 'weighted', weight: 1, elements: [action] })) })
  const surface = { tag: 'column_set', flex_mode: 'none', horizontal_spacing: '0px', margin: '0px', background_style: 'question-surface',
    columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '10px 12px 10px 12px', vertical_spacing: '8px', elements }] }
  return { schema: '2.0', config: { update_multi: true, style: { color: {
    'question-surface': { light_mode: 'rgba(30,130,130,0.06)', dark_mode: 'rgba(85,185,180,0.12)' }
  } } }, body: { padding: '0px', vertical_spacing: '0px', elements: payload.status === 'pending' && payload.actionRef
    ? [{ tag: 'form', name: 'original_question', padding: '0px', vertical_spacing: '0px', elements: [surface] }] : [surface] } }
}
